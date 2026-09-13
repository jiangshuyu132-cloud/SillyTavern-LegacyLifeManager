import test from 'node:test';
import assert from 'node:assert/strict';
import {
    archiveKeywords,
    archiveTitle,
    asObject,
    currentBodySummary,
    detectCarryover,
    extractCharacterCard,
    extractCharacterCards,
    getPath,
    initialPlayerProfile,
    normalizeEntries,
    normalizeStage,
    formatSummaryValue,
    safeFilename,
    supplementalPlayerProfile,
    upsertArchive,
} from '../core.js';
import { createMvuAdapter, statDataFromMessage, statDataFromVariables } from '../mvu-adapter.js';

test('asObject parses JSON and rejects arrays', () => {
    assert.deepEqual(asObject('{"a":1}'), { a: 1 });
    assert.deepEqual(asObject('[1]'), {});
});

test('getPath reads Chinese dotted paths', () => {
    assert.equal(getPath({ 主角: { 等级: 2 } }, '主角.等级'), 2);
    assert.equal(getPath({}, '主角.等级', 'x'), 'x');
});

test('normalizeStage accepts only protocol stages', () => {
    assert.equal(normalizeStage('等待确认'), '等待确认');
    assert.equal(normalizeStage('继续'), '未知');
});

test('extractCharacterCard prefers tagged card', () => {
    assert.equal(extractCharacterCard('正文<char_info>姓名：江书宇\n年龄：20</char_info>尾声'), '姓名：江书宇\n年龄：20');
});

test('extractCharacterCard recognizes fenced data', () => {
    assert.match(extractCharacterCard('```yaml\n姓名: 林\n职业: 骑士\n```'), /职业/);
});

test('extractCharacterCards returns every tagged card', () => {
    const result = extractCharacterCards('<char_info>姓名: 甲</char_info>正文<char_info>姓名: 乙</char_info>');
    assert.deepEqual(result, ['姓名: 甲', '姓名: 乙']);
});

test('initialPlayerProfile reads explicit opening fields', () => {
    const result = initialPlayerProfile([{ is_user: true, mes: '姓名: 江书宇\n身份: 转生者\n性别: 男\n年龄: 16岁\n起始地点: 铁炉堡' }]);
    assert.deepEqual(result, { 姓名: '江书宇', 原主姓名: '江书宇', 身份: '转生者', 性别: '男', 年龄: '16岁', 地点: '铁炉堡' });
});

test('supplementalPlayerProfile matches the player card instead of a newer NPC card', () => {
    const messages = [
        { is_user: true, mes: '姓名: 江书宇\n身份: 转生者\n性别: 男\n年龄: 16岁' },
        { is_user: false, mes: '<char_info>姓名: 江书宇\n种族: 人类（异世界来客）\n身份: 无\n职业: 无（原世界学生）</char_info>' },
        { is_user: false, mes: '<char_info>姓名: 扎伊·克雷顿\n种族: 人类\n身份: 巡逻队副长\n职业: 帝国卫兵</char_info>' },
    ];
    assert.deepEqual(supplementalPlayerProfile(messages, { 主角: {} }), {
        姓名: '江书宇', 原主姓名: '江书宇', 身份: '无', 性别: '男', 年龄: '16岁',
        种族: '人类（异世界来客）', 职业: '无（原世界学生）',
    });
});

test('archiveTitle parses explicit title', () => {
    assert.equal(archiveTitle('第1世·江书宇\n死亡原因：战死'), '第1世·江书宇');
});

test('archiveTitle falls back to summary index', () => {
    const data = { 主角: { 换身状态: { 当前世代编号: 2 } }, 历代记忆摘要: [{ 世代编号: 1, 身体姓名: '江书宇' }] };
    assert.equal(archiveTitle('人生记录', data), '第1世·江书宇');
});

test('archiveKeywords includes generation, name and summary', () => {
    const data = { 历代记忆摘要: [{ 身体姓名: '江书宇', 身份: '冒险者、学生', 详细词条名称: '第1世·江书宇' }] };
    const result = archiveKeywords('第1世·江书宇', '', data);
    assert.ok(result.includes('第1世'));
    assert.ok(result.includes('冒险者'));
});

test('normalizeEntries accepts array lorebooks', () => {
    assert.equal(normalizeEntries({ entries: [{ uid: 8, content: 'x' }] })[8].content, 'x');
});

test('upsertArchive creates, deduplicates and blocks conflicts', () => {
    const first = upsertArchive({ entries: {} }, { title: '第1世·江书宇', content: 'A', keywords: ['江书宇'] });
    assert.equal(first.status, 'created');
    assert.equal(upsertArchive(first.book, { title: '第1世·江书宇', content: 'A', keywords: [] }).status, 'duplicate');
    assert.equal(upsertArchive(first.book, { title: '第1世·江书宇', content: 'B', keywords: [] }).status, 'conflict');
});

test('detectCarryover flags exact non-empty sensitive fields', () => {
    const previous = { 载体档案: { 性格与价值观: '谨慎' }, 技能: { 剑术: {} } };
    const current = { 载体档案: { 性格与价值观: '谨慎' }, 技能: { 剑术: {} } };
    assert.equal(detectCarryover(previous, current).length, 2);
});

test('safeFilename strips reserved characters', () => {
    assert.equal(safeFilename('a/b:c?.json'), 'a-b-c-.json');
});

test('formatSummaryValue renders arrays and explicit empty labels', () => {
    assert.equal(formatSummaryValue(['学生', '冒险者']), '学生、冒险者');
    assert.equal(formatSummaryValue([], '暂无身份'), '暂无身份');
    assert.equal(formatSummaryValue(''), '当前变量未提供');
});

test('currentBodySummary prefers the new carrier profile', () => {
    const result = currentBodySummary({
        主角: {
            载体档案: { 姓名: '林', 年龄: '20', 当前地点与处境: '旅店', 伤病与健康: '健康' },
            种族: '精灵', 身份: ['旅人'], 职业: ['法师'],
        },
        世界: { 地点: '旧地点' },
    });
    assert.equal(result.name, '林');
    assert.deepEqual(Object.fromEntries(result.rows), {
        原主: '当前变量未提供', 年龄: '20', 性别: '当前变量未提供', 种族: '精灵',
        身份: '旅人', 职业: '法师', 地点: '旅店', 健康: '健康',
    });
});

test('currentBodySummary makes legacy chat fields useful without guessing missing data', () => {
    const result = currentBodySummary({
        主角: {
            种族: '人类', 身份: [], 职业: [],
            生命值: { 当前: 206, 上限: { _基础: 200, 额外: 6 } },
            状态效果: {},
        },
        世界: { 地点: '铁炉堡-城防值班室' },
    });
    const rows = Object.fromEntries(result.rows);
    assert.equal(result.name, '当前变量未提供姓名');
    assert.equal(rows.身份, '暂无身份');
    assert.equal(rows.职业, '暂无职业');
    assert.equal(rows.地点, '铁炉堡-城防值班室');
    assert.equal(rows.健康, '生命值 206/206 · 无状态效果');
});

test('currentBodySummary merges a legacy chat character card without replacing live status', () => {
    const result = currentBodySummary({
        主角: {
            种族: '人类', 身份: [], 职业: [],
            生命值: { 当前: 206, 上限: { _基础: 200, 额外: 6 } }, 状态效果: {},
        },
        世界: { 地点: '城防值班室' },
    }, {
        姓名: '江书宇', 原主姓名: '江书宇', 年龄: '16岁', 性别: '男',
        种族: '人类（异世界来客）', 身份: '无', 职业: '无（原世界学生）',
    });
    assert.equal(result.name, '江书宇');
    assert.equal(result.usedSupplementalProfile, true);
    assert.deepEqual(Object.fromEntries(result.rows), {
        原主: '江书宇', 年龄: '16岁', 性别: '男', 种族: '人类（异世界来客）',
        身份: '无', 职业: '无（原世界学生）', 地点: '城防值班室',
        健康: '生命值 206/206 · 无状态效果',
    });
});

test('statDataFromVariables reads object and JSON forms', () => {
    assert.deepEqual(statDataFromVariables({ stat_data: { 主角: { 等级: 2 } } }), { 主角: { 等级: 2 } });
    assert.deepEqual(statDataFromVariables({ stat_data: '{"主角":{"等级":3}}' }), { 主角: { 等级: 3 } });
});

test('statDataFromMessage supports SillyTavern storage fallbacks', () => {
    assert.deepEqual(statDataFromMessage({ extra: { variables: { stat_data: { 主角: { 等级: 4 } } } } }), { 主角: { 等级: 4 } });
});

test('MVU adapter reads exact message floors through TavernHelper.getVariables', () => {
    const chat = [{}, {}, {}];
    const calls = [];
    const env = { TavernHelper: { getVariables(option) {
        calls.push(option);
        return option.message_id === 1 ? { stat_data: { 主角: { 等级: 5 } } } : {};
    } } };
    const adapter = createMvuAdapter({ env, getContext: () => ({ chat }), getLatestMessageIndex: () => 2 });
    assert.deepEqual(adapter.readStatData(), { 主角: { 等级: 5 } });
    assert.deepEqual(calls.map(call => call.message_id), [2, 1]);
});

test('MVU adapter falls back to Mvu.getMvuData', () => {
    const env = { Mvu: { getMvuData: ({ message_id }) => message_id === 0 ? { stat_data: { 主角: { 等级: 6 } } } : {} } };
    const adapter = createMvuAdapter({ env, getContext: () => ({ chat: [{}, {}] }), getLatestMessageIndex: () => 1 });
    assert.equal(adapter.readStatData().主角.等级, 6);
});

test('MVU adapter writes through updateVariablesWith without replacing unrelated data', async () => {
    let stored = { stat_data: { 主角: { 换身状态: {} } }, unrelated: { keep: true } };
    let receivedOption;
    const env = { TavernHelper: {
        updateVariablesWith(updater, option) {
            receivedOption = option;
            stored = updater(stored);
            return stored;
        },
    } };
    const adapter = createMvuAdapter({ env, getContext: () => ({ chat: [{}] }), getLatestMessageIndex: () => 0 });
    await adapter.writeMessagePath('stat_data.主角.换身状态.阶段', '等待确认');
    assert.equal(stored.stat_data.主角.换身状态.阶段, '等待确认');
    assert.equal(stored.unrelated.keep, true);
    assert.deepEqual(receivedOption, { type: 'message', message_id: 'latest' });
});
