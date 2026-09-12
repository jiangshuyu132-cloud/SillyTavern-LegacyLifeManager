import test from 'node:test';
import assert from 'node:assert/strict';
import {
    archiveKeywords,
    archiveTitle,
    asObject,
    detectCarryover,
    extractCharacterCard,
    getPath,
    normalizeEntries,
    normalizeStage,
    safeFilename,
    upsertArchive,
} from '../core.js';

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
