import test from 'node:test';
import assert from 'node:assert/strict';
import { carrierCardSections, carrierBackgroundStory } from '../core.js';
import { initialOpeningRecord, openingMatchesCurrent } from '../opening.js';
import { dossierBodyId, resolveDynamicDossier } from '../dossier.js';

export const openingText = `【剧情生成上下文】
姓名: 林晓
年龄: 28岁
性别: 女
身份: 画师
【初始开局剧情】
【自定义开局】
描述: # 林晓·完整人物小传与角色卡
## 一、人物小传
出生于河畔小城，成年后学习绘画。
# 二、基础资料
姓名：林晓
种族：人类
性别：女
实际年龄：28岁
# 三、基础属性
敏捷：5
# 四、外貌细节
头发：黑色长发。
妆容：无
# 五、当前穿着
上衣：灰色棉衫
# 六、性格与心理结构
谨慎且耐心。
# 七、语言与表达方式
语速舒缓。
# 八、技能与魔法
## 绘画
擅长风景画。
## 调色
使用天然颜料。
# 九、状态效果
## 疲劳
长途步行后需要休息。
# 十、卫生与护理状态
保持整洁。
# 十一、人际关系
## 乐师
一起旅行的老友。
# 十二、持有物与资产
画具与十枚铜币。
# 十三、当前剧情状态
正在进入旅店。
# 十四、可发展的剧情线
## 旅行
计划画下河流。
# 十五、角色扮演与叙事规则
不代替玩家选择。`;
export const openingMessages = () => [{ is_user: false, mes: '<customized>自定义开局开始</customized>' }, { is_user: true, mes: openingText }];
const live = { 主角: { 种族: '人类', 职业: ['画师'], 生命值: { 当前: 100 } } };

test('mixed Markdown headings retain all 15 chapters and nested skills/NPCs', () => {
    const body = initialOpeningRecord(openingMessages());
    assert.equal(body.sourceType, 'opening');
    assert.equal(body.sections.length, 16); // plus the original document title
    assert.equal(body.sections[1].title, '人物小传');
    assert.equal(body.sections.at(-1).title, '角色扮演与叙事规则');
    assert.match(body.sections.find(s => s.title === '技能与魔法').content, /## 绘画[\s\S]*## 调色/);
    assert.match(body.sections.find(s => s.title === '人际关系').content, /## 乐师/);
    assert.equal(carrierBackgroundStory(body.rawCard), '出生于河畔小城，成年后学习绘画。');
    assert.ok(openingMatchesCurrent(body, openingMessages(), live));
});
test('legacy HTML delimiter cards and unnumbered Markdown remain supported', () => {
    assert.deepEqual(carrierCardSections('<div>— 外貌详述 —<br>头发：黑色</div>').map(s => s.title), ['外貌详述']);
    assert.deepEqual(carrierCardSections('## 外貌\n黑发\n### 眼睛\n黑色\n## 穿着\n棉衫').map(s => s.title), ['外貌', '穿着']);
});
test('opening detection rejects later user cards, discussion, NPC and conflicting identity', () => {
    const body = initialOpeningRecord(openingMessages());
    assert.equal(initialOpeningRecord([{ is_user: true, mes: '你好' }, ...openingMessages()]), null);
    assert.equal(initialOpeningRecord([{ is_user: false, mes: openingText }]), null);
    assert.equal(initialOpeningRecord([{ is_user: true, mes: '<discussion_record>' + openingText }]), null);
    assert.equal(initialOpeningRecord([{ is_user: true, mes: openingText.replace('姓名：林晓', '姓名：乐师') }]), null);
    assert.equal(openingMatchesCurrent(body, openingMessages(), { 主角: { 姓名: '另一人', 种族: '人类' } }), false);
    assert.equal(openingMatchesCurrent(body, openingMessages(), { 主角: { 种族: '精灵' } }), false);
    assert.equal(openingMatchesCurrent(body, openingMessages(), { 主角: { 种族: '人类', 生命值: { 当前: 0 } } }), false);
    assert.equal(openingMatchesCurrent(body, openingMessages(), {}), false);
    assert.equal(openingMatchesCurrent(body, [...openingMessages(), { is_user: true, mes: '确认换身' }], live), false);
    assert.equal(openingMatchesCurrent(body, [...openingMessages(), { mes: '【当前载体人物设定开始】候选' }], live), false);
});
test('summary hiding retains exact opening provenance; a different opening cannot restore it', () => {
    const messages = openingMessages(), body = initialOpeningRecord(messages);
    messages[1].is_system = true;
    assert.ok(openingMatchesCurrent(body, messages, live));
    messages[1].mes = messages[1].mes.replace('黑色长发', '棕色短发');
    assert.equal(openingMatchesCurrent(body, messages, live), false);
});
test('opening dynamic updates use the full chapter structure without mutating original', () => {
    const messages = openingMessages(), body = initialOpeningRecord(messages);
    const before = body.rawCard;
    messages.push({ mes: '<gametxt>她化好淡红唇妆。</gametxt><LegacyBodyUpdate>' + JSON.stringify({version: 1, bodyId: dossierBodyId(body), changes: [{op: 'set', section: '外貌细节', field: '妆容', value: '淡红唇妆', evidence: '她化好淡红唇妆。'}]}) + '</LegacyBodyUpdate>' });
    const current = resolveDynamicDossier(body, messages, live);
    assert.equal(current.sections.length, 16);
    assert.match(current.text, /妆容：淡红唇妆/);
    assert.match(current.text, /擅长风景画/);
    assert.equal(body.rawCard, before);
    assert.match(body.rawCard, /妆容：无/);
});
