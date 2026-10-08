import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ok, Err, isOk, isErr } from '../../src/infra/result.js';
import { hostError } from '../../src/infra/errors.js';
import { createContextCollector } from '../../src/application/context-collector.js';
import { createWorldInfoResolver } from '../../src/application/worldinfo-resolver.js';
import { createViewpointBlocksBuilder } from '../../src/application/viewpoint-blocks.js';
import {
    baseSettings,
    createFakeHost,
} from './_fakes.js';

describe('context-collector viewpoint', () => {
    it('messageId collects AI floors from that floor backwards', () => {
        const host = createFakeHost({
            aiMessages: [
                { messageId: 5, name: 'B', text: 'newest', isUser: false, isSystem: false },
                { messageId: 4, name: 'B', text: 'mid', isUser: false, isSystem: false },
                { messageId: 2, name: 'B', text: 'old', isUser: false, isSystem: false },
                { messageId: 1, name: 'U', text: 'user', isUser: true, isSystem: false },
            ],
        });
        // insert a user message between for getMessages path
        host.byId.set(3, {
            messageId: 3, name: 'U', text: 'user mid', isUser: true, isSystem: false,
        });
        const collector = createContextCollector({
            host,
            loadSettings: () => baseSettings({ contextWindowSize: 2 }),
        });
        const win = collector.collect({ messageId: 4 });
        assert.equal(win.messages.length, 2);
        assert.equal(win.messages[0].messageId, 4);
        assert.equal(win.messages[1].messageId, 2);
        assert.equal(win.text, 'old\n\nmid');
    });

    it('without messageId keeps getRecentAiMessages behavior', () => {
        const host = createFakeHost({
            aiMessages: [
                { messageId: 3, name: 'B', text: 'a', isUser: false, isSystem: false },
                { messageId: 2, name: 'B', text: 'b', isUser: false, isSystem: false },
            ],
        });
        let called = 0;
        const orig = host.getRecentAiMessages.bind(host);
        host.getRecentAiMessages = (n) => {
            called += 1;
            return orig(n);
        };
        const collector = createContextCollector({
            host,
            loadSettings: () => baseSettings({ contextWindowSize: 1 }),
        });
        const win = collector.collect();
        assert.equal(called, 1);
        assert.equal(win.messages.length, 1);
        assert.equal(win.messages[0].text, 'a');
    });
});

describe('viewpoint-blocks', () => {
    /**
     * @param {object} [overrides]
     */
    function buildDeps(overrides = {}) {
        const host = overrides.host ?? createFakeHost({
            aiMessages: [
                {
                    messageId: 2,
                    name: 'Bot',
                    text: 'Alice has 金发 in the garden.',
                    isUser: false,
                    isSystem: false,
                },
                {
                    messageId: 1,
                    name: 'Bot',
                    text: 'Earlier.',
                    isUser: false,
                    isSystem: false,
                },
            ],
            worldInfoText: 'WI_OK',
        });
        const settings = overrides.settings ?? baseSettings();
        const characterRepo = overrides.characterRepo ?? {
            listGroups: async () => Ok([{
                id: 'g1', name: '主', active: true, order: 0,
                schemaVersion: 1, createdAt: 't', updatedAt: 't',
            }]),
            listByGroup: async () => Ok([{
                id: 'c1',
                groupId: 'g1',
                name: 'Alice',
                keywords: ['Alice'],
                fixedFeatures: 'dna',
                variableFeatures: [],
                matchOverrides: null,
                schemaVersion: 1,
                createdAt: 't',
                updatedAt: 't',
            }]),
        };
        const tagRepo = overrides.tagRepo ?? {
            listLibraries: async () => Ok([
                {
                    id: 'comp', name: '构图', active: true, kind: 'composition',
                    schemaVersion: 1, createdAt: 't', updatedAt: 't',
                },
                {
                    id: 'feat', name: '特征', active: true, kind: 'feature',
                    schemaVersion: 1, createdAt: 't', updatedAt: 't',
                },
            ]),
            listEntries: async (libId) => {
                if (libId === 'feat') {
                    return Ok([{
                        id: 'fe1',
                        libraryId: 'feat',
                        key: '金发',
                        value: 'blonde hair',
                        schemaVersion: 1,
                        createdAt: 't',
                        updatedAt: 't',
                    }]);
                }
                return Ok([]);
            },
        };
        const loadSettings = () => settings;
        const contextCollector = createContextCollector({ host, loadSettings });
        const worldInfoResolver = createWorldInfoResolver({ host });
        return {
            host,
            characterRepo,
            tagRepo,
            contextCollector,
            worldInfoResolver,
            loadSettings,
        };
    }

    it('builds blocks with character + feature from scan text', async () => {
        const builder = createViewpointBlocksBuilder(buildDeps());
        const r = await builder.build({ extraScanText: 'extra' });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(r.value.messageId, 2);
        assert.equal(r.value.worldInfoText, 'WI_OK');
        assert.match(r.value.contextText, /Alice has/);
        assert.match(r.value.characterText, /Alice/);
        assert.match(r.value.featureText, /金发: blonde hair/);
        assert.equal(r.value.featureEntries.length, 1);
        assert.equal(r.value.constantText, '');
        assert.equal(r.value.constantEntries.length, 0);
    });

    it('active constant libs inject all entries in list / save order; inactive omitted', async () => {
        const builder = createViewpointBlocksBuilder(buildDeps({
            tagRepo: {
                listLibraries: async () => Ok([
                    {
                        id: 'const-b', name: '常驻B', active: true, kind: 'constant',
                        schemaVersion: 1, createdAt: 't', updatedAt: 't',
                    },
                    {
                        id: 'feat', name: '特征', active: true, kind: 'feature',
                        schemaVersion: 1, createdAt: 't', updatedAt: 't',
                    },
                    {
                        id: 'const-a', name: '常驻A', active: true, kind: 'constant',
                        schemaVersion: 1, createdAt: 't', updatedAt: 't',
                    },
                    {
                        id: 'const-off', name: '停用常驻', active: false, kind: 'constant',
                        schemaVersion: 1, createdAt: 't', updatedAt: 't',
                    },
                ]),
                listEntries: async (libId) => {
                    if (libId === 'const-b') {
                        return Ok([
                            {
                                id: 'cb1', libraryId: 'const-b', key: '镜头',
                                value: 'cinematic', schemaVersion: 1, createdAt: 't', updatedAt: 't',
                            },
                        ]);
                    }
                    if (libId === 'const-a') {
                        return Ok([
                            {
                                id: 'ca1', libraryId: 'const-a', key: '杂项甲',
                                value: 'misc a', schemaVersion: 1, createdAt: 't', updatedAt: 't',
                            },
                            {
                                id: 'ca2', libraryId: 'const-a', key: '杂项乙',
                                value: 'misc b', schemaVersion: 1, createdAt: 't', updatedAt: 't',
                            },
                        ]);
                    }
                    if (libId === 'const-off') {
                        return Ok([
                            {
                                id: 'coff', libraryId: 'const-off', key: '不应出现',
                                value: 'nope', schemaVersion: 1, createdAt: 't', updatedAt: 't',
                            },
                        ]);
                    }
                    return Ok([]);
                },
            },
        }));
        const r = await builder.build();
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(
            r.value.constantText,
            '镜头: cinematic\n杂项甲: misc a\n杂项乙: misc b',
        );
        assert.equal(r.value.constantText.includes('不应出现'), false);
        assert.equal(r.value.constantEntries.length, 3);
    });

    it('character repo Err is not degraded to empty', async () => {
        const builder = createViewpointBlocksBuilder(buildDeps({
            characterRepo: {
                listGroups: async () => Err(hostError({
                    code: 'CHAR_READ_FAIL',
                    message: '角色库读失败',
                })),
                listByGroup: async () => Ok([]),
            },
        }));
        const r = await builder.build();
        assert.equal(isErr(r), true);
        assert.equal(r.error.code, 'CHAR_READ_FAIL');
    });

    it('tag repo Err is not degraded to empty', async () => {
        const builder = createViewpointBlocksBuilder(buildDeps({
            tagRepo: {
                listLibraries: async () => Err(hostError({
                    code: 'TAG_READ_FAIL',
                    message: '标签库读失败',
                })),
                listEntries: async () => Ok([]),
            },
        }));
        const r = await builder.build();
        assert.equal(isErr(r), true);
        assert.equal(r.error.code, 'TAG_READ_FAIL');
    });

    it('missing viewpoint → Err', async () => {
        const builder = createViewpointBlocksBuilder(buildDeps({
            host: createFakeHost({ aiMessages: [] }),
        }));
        const r = await builder.build();
        assert.equal(isErr(r), true);
        assert.equal(r.error.code, 'VIEWPOINT_NOT_FOUND');
    });
});
