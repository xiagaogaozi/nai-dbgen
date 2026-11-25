import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { installFakeDom } from './fake-dom.js';
import { readImageCaption, extractStealthFromImageData } from '../../src/ui/common/png-caption.js';
import { matchImageArtist } from '../../src/ui/common/image-artist-match.js';
import { mountWorkbench } from '../../src/ui/workbench/workbench.js';
import { mountStoragePanel } from '../../src/ui/panels/storage/storage-panel.js';
import { defaultPluginSettings } from '../../src/domain/model/plugin-settings.js';
import { emptyNaiCaption } from '../../src/domain/model/nai-params.js';
import { Ok } from '../../src/infra/result.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePngWithText(key, value) {
    const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const enc = new TextEncoder();
    const k = enc.encode(key);
    const v = enc.encode(value);
    const textData = new Uint8Array(k.length + 1 + v.length);
    textData.set(k, 0);
    textData[k.length] = 0;
    textData.set(v, k.length + 1);

    function chunk(type, data) {
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        return out;
    }

    const c1 = chunk('tEXt', textData);
    const c2 = chunk('IEND', new Uint8Array(0));
    const all = new Uint8Array(sig.length + c1.length + c2.length);
    all.set(sig, 0);
    all.set(c1, sig.length);
    all.set(c2, sig.length + c1.length);
    return new Blob([all], { type: 'image/png' });
}

function makeJpegWithCom(text) {
    const enc = new TextEncoder();
    const payload = enc.encode(text);
    const len = payload.length + 2;
    const out = new Uint8Array(2 + 4 + payload.length + 2);
    out[0] = 0xff; out[1] = 0xd8;
    out[2] = 0xff; out[3] = 0xfe;
    out[4] = (len >> 8) & 0xff; out[5] = len & 0xff;
    out.set(payload, 6);
    out[6 + payload.length] = 0xff;
    out[7 + payload.length] = 0xd9;
    return new Blob([out], { type: 'image/jpeg' });
}

function encodeStealthRgba(sigText, payloadBytes, mode) {
    const sigBytes = new TextEncoder().encode(sigText);
    const bitLen = payloadBytes.length * 8;
    const lenBytes = Uint8Array.from([
        (bitLen >>> 24) & 0xff,
        (bitLen >>> 16) & 0xff,
        (bitLen >>> 8) & 0xff,
        bitLen & 0xff,
    ]);
    const full = new Uint8Array(sigBytes.length + 4 + payloadBytes.length);
    full.set(sigBytes, 0);
    full.set(lenBytes, sigBytes.length);
    full.set(payloadBytes, sigBytes.length + 4);

    const totalBits = full.length * 8;
    const height = 16;
    const width = Math.ceil((mode === 'alpha' ? totalBits : Math.ceil(totalBits / 3)) / height) + 2;
    const data = new Uint8ClampedArray(width * height * 4);
    data.fill(254);

    let cursor = 0;
    for (let i = 0; i < full.length; i += 1) {
        for (let b = 7; b >= 0; b -= 1) {
            const bit = (full[i] >> b) & 1;
            if (mode === 'alpha') {
                const x = Math.floor(cursor / height);
                const y = cursor % height;
                data[(y * width + x) * 4 + 3] = (data[(y * width + x) * 4 + 3] & 0xfe) | bit;
            } else {
                const px = Math.floor(cursor / 3);
                const ch = cursor % 3;
                const x = Math.floor(px / height);
                const y = px % height;
                data[(y * width + x) * 4 + ch] = (data[(y * width + x) * 4 + ch] & 0xfe) | bit;
            }
            cursor += 1;
        }
    }
    return { data, width, height };
}

function click(node) {
    assert.ok(node, 'clickable node missing');
    const ev = { target: node, preventDefault() {}, stopPropagation() {} };
    for (const l of (node._listeners || []).filter((x) => x.type === 'click')) {
        l.fn(ev);
    }
}

function findButton(root, label) {
    return root.querySelectorAll('button').find((b) => String(b.textContent || '') === label);
}

describe('image metadata parser (PNG text / stealth / JPEG)', () => {
    it('reads PNG tEXt v4_prompt with character captions', async () => {
        const blob = makePngWithText('Comment', JSON.stringify({
            v4_prompt: {
                caption: {
                    base_caption: 'artist:foo, 1girl, sunset',
                    char_captions: [{ char_caption: 'blue eyes, smile', centers: [{ x: 0.3, y: 0.5 }] }],
                },
            },
            v4_negative_prompt: {
                caption: {
                    base_caption: 'lowres, bad anatomy',
                    char_captions: [{ char_caption: 'angry', centers: [{ x: 0.3, y: 0.5 }] }],
                },
            },
        }));
        const caption = await readImageCaption(blob);
        assert.equal(caption.v4_prompt.caption.base_caption, 'artist:foo, 1girl, sunset');
        assert.equal(caption.v4_negative_prompt.caption.base_caption, 'lowres, bad anatomy');
        assert.equal(caption.v4_prompt.caption.char_captions.length, 1);
        assert.equal(caption.v4_prompt.caption.char_captions[0].char_caption, 'blue eyes, smile');
    });

    it('reads stealth_pnginfo (alpha) and stealth_rgbcomp (rgb gzip) pixel metadata', async () => {
        const alphaJson = JSON.stringify({ prompt: 'alpha prompt', uc: 'alpha uc' });
        const alphaImg = encodeStealthRgba('stealth_pnginfo', new TextEncoder().encode(alphaJson), 'alpha');
        const alphaMeta = await extractStealthFromImageData(alphaImg.data, alphaImg.width, alphaImg.height);
        assert.equal(alphaMeta.prompt, 'alpha prompt');
        assert.equal(alphaMeta.uc, 'alpha uc');

        const rgbJson = JSON.stringify({
            Comment: JSON.stringify({
                prompt: 'rgb prompt',
                uc: 'rgb uc',
                characterPrompts: [{ prompt: 'char A', uc: 'bad A', center: { x: 0.2, y: 0.8 } }],
            }),
        });
        const rgbImg = encodeStealthRgba('stealth_rgbcomp', new Uint8Array(gzipSync(rgbJson)), 'rgb');
        const rgbMeta = await extractStealthFromImageData(rgbImg.data, rgbImg.width, rgbImg.height);
        assert.ok(rgbMeta.Comment);
    });

    it('reads JPEG COM segment with characterPrompts fallback', async () => {
        const blob = makeJpegWithCom(JSON.stringify({
            prompt: 'jpeg base',
            uc: 'jpeg neg',
            characterPrompts: [{ prompt: 'cat ears', uc: 'dog ears', center: { x: 0.4, y: 0.6 } }],
        }));
        const caption = await readImageCaption(blob);
        assert.equal(caption.v4_prompt.caption.base_caption, 'jpeg base');
        assert.equal(caption.v4_negative_prompt.caption.base_caption, 'jpeg neg');
        assert.equal(caption.v4_prompt.caption.char_captions[0].char_caption, 'cat ears');
        assert.equal(caption.v4_negative_prompt.caption.char_captions[0].char_caption, 'dog ears');
    });

    it('prefers exact artist match when multiple prefix matches exist', () => {
        const artists = [
            { id: 'a1', name: 'Short', positivePrompt: 'artist:a', negativePrompt: 'bad' },
            { id: 'a2', name: 'Long', positivePrompt: 'artist:a, style:b', negativePrompt: 'bad' },
        ];
        const caption = {
            v4_prompt: { caption: { base_caption: 'artist:a', char_captions: [] } },
            v4_negative_prompt: { caption: { base_caption: 'bad', char_captions: [] } },
        };
        const matched = matchImageArtist(caption, artists);
        assert.equal(matched.artist?.id, 'a1');
        assert.equal(matched.caption.v4_prompt.caption.base_caption, '');
    });
});

describe('workbench metadata import, layout, save modal & unsaved protection', () => {
    let fake;
    let handles;

    beforeEach(() => {
        fake = installFakeDom();
        handles = [];
    });

    afterEach(() => {
        for (const h of handles) h.destroy();
        fake.restore();
    });

    function setupWorkbench({ artists, savedCalls } = {}) {
        const list = artists ?? [
            { id: 'a1', name: 'Alpha', positivePrompt: 'artist:alpha', negativePrompt: 'neg:alpha' },
        ];
        const calls = savedCalls ?? [];
        const toasts = [];
        const artistRepo = {
            list: async () => Ok(list),
            get: async (id) => Ok(list.find((it) => it.id === id) ?? null),
        };
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);
        const handle = mountWorkbench(root, {
            host: { toast: (level, message) => toasts.push({ level, message }) },
            artistRepo,
            repos: { artist: artistRepo },
            loadSettings: () => ({ ...defaultPluginSettings(), activeArtistId: 'a1' }),
            workbenchService: {
                writePrompt: async () => Ok({ caption: emptyNaiCaption(), unmatchedKeys: [] }),
                generateImage: async () => Ok([]),
            },
            artistDraftService: {
                async save(req) {
                    calls.push(req);
                    const saved = {
                        id: req.mode === 'update' ? req.artistId : `created-${calls.length}`,
                        name: req.name,
                        positivePrompt: req.positivePrompt,
                        negativePrompt: req.negativePrompt,
                        modelTag: req.modelTag,
                    };
                    const idx = list.findIndex((x) => x.id === saved.id);
                    if (idx >= 0) list[idx] = saved;
                    else list.push(saved);
                    return Ok(saved);
                },
            },
        });
        handles.push(handle);
        return { root, handle, calls, toasts, list };
    }

    it('places sourceBar above artistSlot with upload button closest to current artist, and merges save button', async () => {
        const ctx = setupWorkbench();
        await flush();
        const middle = ctx.root.querySelector('.nd-wb-column--middle');
        const sourceBar = ctx.root.querySelector('.nd-wb-source');
        const artistSlot = ctx.root.querySelector('.nd-wb-artist-slot');
        assert.equal(middle.childNodes[0], sourceBar, 'sourceBar is above artistSlot');
        assert.equal(middle.childNodes[1], artistSlot);
        assert.equal(sourceBar.childNodes[0].className, 'nd-wb-source__actions');
        assert.equal(sourceBar.childNodes[1].className, 'nd-wb-source__box', 'upload box is right above current artist');
        assert.ok(sourceBar.querySelector('.nd-wb-source__pick'));
        const clearBtn = sourceBar.querySelector('.nd-wb-source__clear');
        assert.ok(clearBtn);
        assert.equal(clearBtn.hidden, true);

        const parseBtn = findButton(sourceBar, '解析原图');
        const reverseBtn = findButton(sourceBar, '反推重绘');
        const img2imgBtn = findButton(sourceBar, '图生图');
        assert.ok(parseBtn && reverseBtn && img2imgBtn);
        assert.equal(parseBtn.parentNode, reverseBtn.parentNode);
        assert.equal(reverseBtn.parentNode, img2imgBtn.parentNode);

        assert.ok(findButton(artistSlot, '保存画师串'));
        assert.equal(findButton(artistSlot, '保存到当前画师串'), undefined);
        assert.equal(findButton(artistSlot, '新建画师串'), undefined);

        // 点击「保存画师串」弹出带「新建 / 覆盖」切换的统一界面
        click(findButton(artistSlot, '保存画师串'));
        await flush();
        const dialog = document.body.querySelector('dialog');
        assert.ok(dialog);
        const createTab = findButton(dialog, '新建');
        const updateTab = findButton(dialog, '覆盖');
        assert.ok(createTab && updateTab);
        assert.equal(updateTab.getAttribute('aria-selected'), 'true');
        click(createTab);
        assert.equal(createTab.getAttribute('aria-selected'), 'true');
        click(findButton(dialog, '确认新建'));
        await flush();
        assert.equal(ctx.calls.length, 1);
        assert.equal(ctx.calls[0].mode, 'create');
    });

    it('imports unfamiliar image into artist fields + character area, keeps scene, and shows 新建画师串', async () => {
        const ctx = setupWorkbench();
        await flush();

        // 先在场景里写入已有提示词，验证陌生原图不覆盖场景
        const sceneField = ctx.root.querySelectorAll('.nd-field')
            .find((f) => f.querySelector('.nd-field__label')?.textContent === '场景 · 正面');
        const sceneTa = sceneField.querySelector('textarea');
        sceneTa.value = 'existing scene prompt';

        const strangerBlob = makePngWithText('Comment', JSON.stringify({
            v4_prompt: {
                caption: {
                    base_caption: 'stranger artist, dreamy lighting',
                    char_captions: [{ char_caption: 'silver hair, red eyes', centers: [{ x: 0.5, y: 0.5 }] }],
                },
            },
            v4_negative_prompt: {
                caption: {
                    base_caption: 'stranger negative',
                    char_captions: [{ char_caption: 'bad hands', centers: [{ x: 0.5, y: 0.5 }] }],
                },
            },
        }));

        await ctx.handle.importFromPanel({ imageBlob: strangerBlob });
        await flush();

        const artistPickerInput = ctx.root.querySelector('.nd-wb-artist').querySelector('input');
        const artistPrompts = ctx.root.querySelector('.nd-wb-artist-prompts').querySelectorAll('textarea');
        assert.equal(artistPickerInput.value, '新建画师串');
        assert.equal(artistPrompts[0].value, 'stranger artist, dreamy lighting');
        assert.equal(artistPrompts[1].value, 'stranger negative');
        assert.equal(sceneTa.value, 'existing scene prompt', 'scene prompt is preserved');

        const charPosField = ctx.root.querySelectorAll('.nd-field')
            .find((f) => f.querySelector('.nd-field__label')?.textContent === '正面');
        assert.equal(charPosField.querySelector('textarea').value, 'silver hair, red eyes');
    });

    it('prompts with 保存并覆盖 / 直接覆盖 / 取消 when artist draft has unsaved changes', async () => {
        const ctx = setupWorkbench();
        await flush();

        const artistPrompts = ctx.root.querySelector('.nd-wb-artist-prompts').querySelectorAll('textarea');
        artistPrompts[0].value = 'unsaved local edit';

        const matchedBlob = makePngWithText('Comment', JSON.stringify({
            v4_prompt: { caption: { base_caption: 'artist:alpha, forest', char_captions: [] } },
            v4_negative_prompt: { caption: { base_caption: 'neg:alpha, blurry', char_captions: [] } },
        }));

        // 1) 点「取消」不覆盖
        const pCancel = ctx.handle.importFromPanel({ imageBlob: matchedBlob });
        await flush();
        let dialog = document.body.querySelector('dialog');
        assert.ok(dialog);
        assert.ok(findButton(dialog, '保存并覆盖'));
        assert.ok(findButton(dialog, '直接覆盖'));
        assert.ok(findButton(dialog, '取消'));
        click(findButton(dialog, '取消'));
        await pCancel;
        assert.equal(artistPrompts[0].value, 'unsaved local edit');

        // 2) 点「保存并覆盖」跳转到保存画师串界面，保存后自动继续覆盖
        const pSave = ctx.handle.importFromPanel({ imageBlob: matchedBlob });
        await flush();
        dialog = document.body.querySelector('dialog');
        click(findButton(dialog, '保存并覆盖'));
        await flush();
        const saveDialog = document.body.querySelector('dialog');
        assert.ok(saveDialog);
        assert.ok(findButton(saveDialog, '新建'));
        assert.ok(findButton(saveDialog, '覆盖'));
        click(findButton(saveDialog, '新建'));
        click(findButton(saveDialog, '确认新建'));
        await pSave;
        await flush();
        assert.equal(ctx.calls.length, 1);
        assert.equal(ctx.calls[0].positivePrompt, 'unsaved local edit');
        assert.equal(artistPrompts[0].value, 'artist:alpha');

        // 3) 再次修改后点「直接覆盖」
        artistPrompts[0].value = 'discard me';
        const pDirect = ctx.handle.importFromPanel({ imageBlob: matchedBlob });
        await flush();
        dialog = document.body.querySelector('dialog');
        click(findButton(dialog, '直接覆盖'));
        await pDirect;
        await flush();
        assert.equal(artistPrompts[0].value, 'artist:alpha');
    });

    it('storage panel reuse delegates imageBlob directly to importToWorkbench', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);
        const blob = makePngWithText('Comment', JSON.stringify({ prompt: 'test' }));
        const imported = [];
        const handle = mountStoragePanel(root, {
            host: {
                toast: () => {},
                loadSettings: () => ({ imageCacheLimit: 500 }),
                saveSettings: () => {},
            },
            importToWorkbench: async (payload) => { imported.push(payload); },
            repos: {
                image: {
                    estimateUsage: async () => Ok({ bytes: 100, count: 1, quota: null, usage: null }),
                    listMeta: async () => Ok([{ id: 'img-1', size: 100, createdAt: '2026-01-01', pinned: false, mimeType: 'image/png' }]),
                    getUrl: async () => Ok('blob:mock/img-1'),
                    getBlob: async () => Ok(blob),
                },
            },
        });
        handles.push(handle);
        await new Promise((r) => setTimeout(r, 15));
        const reuseBtn = findButton(root, '复用到工作台');
        assert.ok(reuseBtn);
        click(reuseBtn);
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(imported.length, 1);
        assert.equal(imported[0].imageBlob, blob);
    });
});
