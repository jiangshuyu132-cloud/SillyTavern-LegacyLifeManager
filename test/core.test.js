import test from 'node:test';
import assert from 'node:assert/strict';
import {
    archiveKeywords,
    archiveTitle,
    asObject,
    buildLifeRecord,
    carrierGeneration,
    carrierCardSections,
    carrierCardText,
    carrierRecordKey,
    compactLifeIndex,
    confirmedCarrierProfile,
    confirmedCarrierRecords,
    conversationLedgerTruth,
    crossLifeMoneyTransition,
    currentBehaviorProfile,
    currentBodySummary,
    detectCarryover,
    extractCarrierCards,
    extractCharacterCard,
    extractCharacterCards,
    extractJsonPatchOperations,
    getPath,
    initialPlayerProfile,
    inferredLivesFromCarrierCard,
    isCarrierConfirmation,
    lifeHistorySummaries,
    lifeSummariesFromCarrierCard,
    lifeSummariesFromUpdateVariable,
    liveBodyState,
    mergeLifeRecords,
    normalizedMoney,
    normalizeEntries,
    normalizeStage,
    formatSummaryValue,
    safeFilename,
    parseCarrierCard,
    replayDynamicStatData,
    rebuildConversationLives,
    responseSummaries,
    stableTextFingerprint,
    smartInjectionUsesFullCard,
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

test('replays latest-dynamic alias patches into the current protagonist view', () => {
    const response = `<UpdateVariable><JSONPatch>[
      {"op":"replace","path":"/最新动态/生命值/当前","value":391},
      {"op":"add","path":"/最新动态/状态效果/小腿割伤","value":{"描述":"左小腿被小刀划伤","效果":"轻微渗血","持续":"未处理"}},
      {"op":"add","path":"/主角/载体档案/身体改造","value":"左臂魔导义体"}
    ]</JSONPatch></UpdateVariable>`;
    assert.equal(extractJsonPatchOperations(response).length, 3);
    const result = replayDynamicStatData({
        主角: {
            生命值: { 当前: 0, 上限: { _基础: 413, 额外: 0 } },
            状态效果: {},
            载体档案: { 姓名: '纳蕾' },
        },
    }, [{ is_user: false, mes: response }]);
    assert.equal(result.appliedOperations, 3);
    assert.equal(result.statData.主角.生命值.当前, 391);
    assert.equal(result.statData.主角.状态效果.小腿割伤.持续, '未处理');
    assert.equal(result.statData.主角.载体档案.身体改造, '左臂魔导义体');
});

test('dynamic replay ignores unrelated roots, user messages and unsafe pointers', () => {
    const messages = [
        { is_user: true, mes: '<JSONPatch>[{"op":"replace","path":"/主角/等级","value":99}]</JSONPatch>' },
        { is_user: false, mes: '<JSONPatch>[{"op":"replace","path":"/新闻/内容","value":"x"},{"op":"add","path":"/主角/__proto__/polluted","value":true}]</JSONPatch>' },
    ];
    const result = replayDynamicStatData({ 主角: { 等级: 1 } }, messages);
    assert.equal(result.appliedOperations, 0);
    assert.equal(result.statData.主角.等级, 1);
    assert.equal({}.polluted, undefined);
});

test('smart injection uses the full card only before the first post-confirmation reply', () => {
    const body = { confirmationMessageIndex: 1 };
    assert.equal(smartInjectionUsesFullCard(body, [
        { is_user: false, mes: '候选卡' },
        { is_user: true, mes: '确认换身' },
    ]), true);
    assert.equal(smartInjectionUsesFullCard(body, [
        { is_user: false, mes: '候选卡' },
        { is_user: true, mes: '确认换身' },
        { is_user: false, mes: '换身后首轮正文' },
    ]), false);
});

test('compact life index keeps concise recent histories within its budget', () => {
    const text = compactLifeIndex([
        { generation: 1, name: '甲', summary: '甲'.repeat(300) },
        { generation: 2, name: '乙', summary: '在铁炉堡生活并战死。' },
    ], 180);
    assert.ok(text.length <= 220);
    assert.match(text, /第2世·乙/);
    assert.match(text, /更早 1 世已存档/);
});

test('live body state keeps full status descriptions but filters unrelated stable fields', () => {
    const result = liveBodyState({
        世界: { 地点: '旧地点' },
        主角: {
            当前地点: '洗衣坊',
            生命值: { 当前: 391, 上限: { _基础: 411, 额外: 0 } },
            状态效果: { 小腿割伤: { 描述: '小刀划伤', 效果: '渗血', 持续: '未处理' } },
            载体档案: { 性格与价值观: '谨慎', 当前穿着: '粗麻衣', 身体改造: '左臂魔导义体' },
            技能: { 洗涤: 3 },
        },
    });
    assert.equal(result.当前地点, '洗衣坊');
    assert.equal(result.状态效果.小腿割伤.持续, '未处理');
    assert.equal(result.身体动态变化.身体改造, '左臂魔导义体');
    assert.equal(result.身体动态变化.性格与价值观, undefined);
    assert.equal(result.技能, undefined);
});

test('current behavior profile keeps all decision-lens fields and prefers live development', () => {
    const card = `
<b>当前原主性格与价值观：</b>沉默谨慎，但被逼到底线时会固执拒绝。<br>
<b>思维方式：</b>先确认退路，再处理眼前问题。<br>
<b>喜恶：</b>喜欢热粥；害怕矿区。<br>
<b>愿望与恐惧：</b>想租一间小屋；害怕再次被抛下。<br>
<b>生活习惯：</b>天不亮起床烧水。<br>
<b>当前感情：</b>对陌生人保持警惕。<br>
<b>当前知识与语言：</b>只懂本地口语和洗衣工作。<br>
<b>技能与能力：</b>熟练洗涤，战斗经验很少。<br>`;
    const result = currentBehaviorProfile(card, {
        主角: { 载体档案: { 性格与价值观: '经历危机后仍谨慎，但更愿意主动求助。' } },
    });
    assert.equal(result.性格与价值观, '经历危机后仍谨慎，但更愿意主动求助。');
    assert.equal(result.思维方式与认知边界, '先确认退路，再处理眼前问题。');
    assert.match(result.愿望与恐惧, /再次被抛下/);
    assert.match(result.当前技能与身体经验, /战斗经验很少/);
    const strict = currentBehaviorProfile(card, {
        主角: { 载体档案: { 性格与价值观: '变量里的简略谨慎。' } },
    }, { preferCard: true });
    assert.match(strict.性格与价值观, /被逼到底线/);
    assert.doesNotMatch(strict.性格与价值观, /变量里的简略/);
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

const carrierCard = `【当前载体人物设定开始】
<div><b>世代编号：</b>第2世（若确认）<br>
<b>姓名：</b>若莎·阿泽恩（Zhosha Adzern）<br>
<b>性别：</b>女<br>
<b>种族：</b>人类<br>
<b>年龄：</b>15岁｜外貌年龄15岁<br>
<b>身份职业：</b>铁炉堡裁缝铺学徒<br>
<b>社会地位：</b>平民阶层。家境清贫但温饱无虞。<br>
<b>当前地点：</b>铁炉堡工匠区裁缝铺二楼<br>
<b>接管瞬间处境与健康：</b>身体健康，无伤病。<br>
<b>历代经历记忆：</b><br>
· 第1世：江书宇——从现代中国穿越到铁炉堡，次日被盗匪流矢射杀。<br>
<b>上一具身体死亡信息：</b>箭矢贯穿头部，当场死亡。<br>
<b>※ 历代旧人格均未继承。</b></div>
【当前载体人物设定结束】`;

const actualCarrierCardVariant = `【当前载体人物设定开始】
<div><b>世代编号：</b>第2世（待确认）<br>
<b>姓名：</b>忒娜·厄尔伯<br>
<b>性别：</b>女<br>
<b>===== 历代经历记忆 =====</b><br>
第1世·江书宇：来自异世界的年轻人，在铁炉堡存活不足一天。<br>
死亡原因：流矢穿颅（箭从左太阳穴射入，右太阳穴穿出）。<br><br>
<b>===== 不继承声明 =====</b><br>
历代旧人格均未继承。</div>
【当前载体人物设定结束】`;

// Fixtures now carry actual before/after MVU snapshots; text alone is not a commit.
function confirmedFixture(card=carrierCard, stamp='1') {
    const profile=parseCarrierCard(extractCarrierCards(card)[0]);
    const before={主角:{载体档案:{姓名:'江书宇'},换身状态:{阶段:'等待确认',当前身体死亡已确认:true,当前世代编号:1,待确认人物卡:card,当前身体死亡信息:'已死亡',待归档人生词条:'',归档写入状态:'无待处理'}},历代记忆摘要:[]};
    const after={主角:{载体档案:profile,换身状态:{阶段:'当前身体生效',当前身体死亡已确认:false,当前世代编号:2,待确认人物卡:'',当前身体死亡信息:'',待归档人生词条:'词条名称: 第1世·江书宇\n经历',归档写入状态:'待写入世界书'}},历代记忆摘要:[{世代编号:1,身体姓名:'江书宇',详细词条名称:'第1世·江书宇'}]};
    return [{is_user:false,mes:card,send_date:'card-'+stamp,stat_data:before},{is_user:true,mes:'确认换身',send_date:'confirm-'+stamp},{is_user:false,mes:'客观感官交接。',stat_data:after}];
}

test('parseCarrierCard reads the HTML carrier format used by the story', () => {
    const [card] = extractCarrierCards(carrierCard);
    assert.deepEqual(parseCarrierCard(card), {
        姓名: '若莎·阿泽恩（Zhosha Adzern）',
        原主姓名: '若莎·阿泽恩（Zhosha Adzern）',
        年龄: '15岁｜外貌年龄15岁',
        性别: '女',
        种族: '人类',
        身份: '平民阶层',
        职业: '铁炉堡裁缝铺学徒',
        地点: '铁炉堡工匠区裁缝铺二楼',
        伤病与健康: '身体健康，无伤病。',
    });
});

test('confirmedCarrierProfile uses only the latest card followed by exact confirmation', () => {
    const messages = [
        ...confirmedFixture(),
        { is_user: false, mes: carrierCard.replaceAll('若莎·阿泽恩（Zhosha Adzern）', '未确认的新候选') },
    ];
    assert.equal(confirmedCarrierRecords(messages).length, 1);
    assert.equal(confirmedCarrierProfile(messages).姓名, '若莎·阿泽恩（Zhosha Adzern）');
});

test('confirmation rejects explanatory options and discussion', () => {
    assert.equal(isCarrierConfirmation('确认换身'), true);
    assert.equal(isCarrierConfirmation('发送“确认换身”，正式接管朵丽的身体，开始第二世的生活'), false);
    assert.equal(isCarrierConfirmation('我想问问“确认换身”是什么意思'), false);
});

test('legacy explanatory option cannot commit a candidate', () => {
    const messages = [
        { is_user: false, mes: carrierCard },
        { is_user: true, mes: '发送"确认换身"，正式接管若莎的身体，开始第二世的生活' },
    ];
    assert.equal(confirmedCarrierProfile(messages).姓名, undefined);
});

test('conversation ledger truth disappears when card and confirmation floors are deleted', () => {
    const confirmed = [
        ...confirmedFixture(carrierCard,'1'),
    ];
    const truth = conversationLedgerTruth(confirmed);
    assert.equal(truth.currentRecord.profile.姓名, '若莎·阿泽恩（Zhosha Adzern）');
    assert.equal(truth.lives[0].title, '第1世·江书宇');

    assert.deepEqual(conversationLedgerTruth([{ is_user: true, mes: '随机', send_date: 'reroll-1' }]), {
        records: [],
        currentRecord: null,
        lives: [],
    });
});

test('cleared confirmations stay suppressed without blocking a newly generated confirmation', () => {
    const first = [
        ...confirmedFixture(carrierCard,'1'),
    ];
    const firstRecord = confirmedCarrierRecords(first)[0];
    const suppressedKey = carrierRecordKey(firstRecord, first);
    assert.equal(conversationLedgerTruth(first, [suppressedKey]).currentRecord, null);

    const regenerated = [
        ...confirmedFixture(carrierCard,'2'),
    ];
    const regeneratedRecord = confirmedCarrierRecords(regenerated)[0];
    assert.notEqual(suppressedKey, carrierRecordKey(regeneratedRecord, regenerated));
    assert.ok(conversationLedgerTruth(regenerated, [suppressedKey]).currentRecord);
});

test('carrier fingerprints and generation parsing are deterministic', () => {
    assert.equal(stableTextFingerprint(carrierCard), stableTextFingerprint(`\r${carrierCard}\r`));
    assert.equal(carrierGeneration(extractCarrierCards(carrierCard)[0]), 2);
    assert.equal(rebuildConversationLives([
        ...confirmedFixture(),
    ])[0].name, '江书宇');
});

test('carrier card keeps complete text and splits display sections', () => {
    const text = carrierCardText(extractCarrierCards(carrierCard)[0]);
    assert.match(text, /历代经历记忆/);
    const sections = carrierCardSections('<div>说明<br>— 当前形态基础 —<br>姓名：朵丽<br>— 外貌详述 —<br>棕发</div>');
    assert.deepEqual(sections.map(item => item.title), ['人物卡说明', '当前形态基础', '外貌详述']);
    assert.match(sections[2].content, /棕发/);
});

test('response summaries and life records preserve concise life experience', () => {
    const messages = [
        { is_user: false, mes: '<summary>抵达铁炉堡并被卫兵盘查。</summary>' },
        { is_user: true, mes: '等待' },
        { is_user: false, mes: '<summary>在城东被流矢射杀。</summary>' },
    ];
    assert.deepEqual(responseSummaries(messages).map(item => item.text), ['抵达铁炉堡并被卫兵盘查。', '在城东被流矢射杀。']);
    const record = buildLifeRecord({ generation: 1, profile: { 姓名: '江书宇' }, startMessageIndex: 0 }, messages, 2);
    assert.equal(record.title, '第1世·江书宇');
    assert.match(record.summary, /流矢射杀/);
});

test('inferred lives recover history from an imported current-body card', () => {
    const lives = inferredLivesFromCarrierCard(extractCarrierCards(carrierCard)[0]);
    assert.equal(lives[0].title, '第1世·江书宇');
    assert.equal(lives[0].source, 'imported-card');
});

test('actual v2 card variants preserve separate identity, occupation, health and legacy index', () => {
    const card = `<div><b>姓名:</b> 朵丽<br><b>身份:</b> 驻军军需处洗衣工<br><b>职业:</b> 洗衣工、缝补工<br><b>健康:</b> 双手有裂口。<br><b>历代经历记忆简短索引:</b><br>· 第1世·江书宇 —— 抵达铁炉堡后被流矢射杀。<br><b>上一具身体死亡信息:</b> 已死亡</div>`;
    assert.deepEqual(parseCarrierCard(card), {
        姓名: '朵丽', 原主姓名: '朵丽', 身份: '驻军军需处洗衣工', 职业: '洗衣工、缝补工', 伤病与健康: '双手有裂口。',
    });
    assert.equal(lifeSummariesFromCarrierCard(card)[0].title, '第1世·江书宇');
});

test('actual v2 heading and colon format recovers the complete previous-life summary', () => {
    const [life] = lifeSummariesFromCarrierCard(extractCarrierCards(actualCarrierCardVariant)[0]);
    assert.equal(life.title, '第1世·江书宇');
    assert.match(life.summary, /存活不足一天/);
    assert.match(life.summary, /死亡原因：流矢穿颅/);
});

test('partial JSONPatch is extractable history text but cannot prove an MVU commit', () => {
    const response = `<UpdateVariable><JSONPatch>[{
      "op":"insert",
      "path":"/历代记忆摘要/-",
      "value":{"世代编号":1,"身体姓名":"江书宇","身份":"无（异世界来客）","所处时期":"复兴纪元488年9月15日-16日","最重要经历":"在铁炉堡被流矢射杀","死亡原因":"流矢穿颅"}
    }]</JSONPatch></UpdateVariable>`;
    const [life] = lifeSummariesFromUpdateVariable(response);
    assert.equal(life.title, '第1世·江书宇');
    assert.match(life.summary, /在铁炉堡被流矢射杀/);

    const truth = conversationLedgerTruth([
        { is_user: false, mes: actualCarrierCardVariant.replace(/<b>===== 历代经历记忆 =====<\/b>[\s\S]*?<b>===== 不继承声明 =====<\/b>/, '<b>===== 不继承声明 =====</b>') },
        { is_user: true, mes: '确认换身' },
        { is_user: false, mes: response },
    ]);
    assert.equal(truth.currentRecord, null);
    assert.deepEqual(truth.lives, []);
});

test('recovers a confirmed carrier when an old MVU schema strips only protocol fields', () => {
    const card = `【当前载体人物设定开始】
<div><b>世代编号：</b>第2世<br><b>姓名：</b>芙莉莲<br><b>种族：</b>高等精灵<br><b>职业：</b>法师<br><b>当前地点：</b>彩玉区出租屋<br><b>历代经历记忆：</b><br>第1世·旧身：在暗巷中死亡。</div>
【当前载体人物设定结束】`;
    const candidatePatch = `<UpdateVariable><JSONPatch>${JSON.stringify([
        { op: 'replace', path: '/主角/换身状态', value: { 阶段: '等待确认', 当前世代编号: 1, 当前身体死亡已确认: true, 当前身体死亡信息: '已死亡', 待确认人物卡: '【候选】芙莉莲，高等精灵女性，法师。详细设定见正文候选卡。', 待归档人生词条: '', 归档写入状态: '无待处理' } },
    ])}</JSONPatch></UpdateVariable>`;
    const commitPatch = `<UpdateVariable><JSONPatch>${JSON.stringify([
        { op: 'replace', path: '/主角/换身状态', value: { 阶段: '当前身体生效', 当前世代编号: 2, 当前身体死亡已确认: false, 当前身体死亡信息: '', 待确认人物卡: '', 待归档人生词条: '词条名称: 第1世·旧身\n经历', 归档写入状态: '待写入世界书' } },
        { op: 'replace', path: '/主角/载体档案', value: { 姓名: '芙莉莲', 种族: '高等精灵', 职业: '法师', 地点: '彩玉区出租屋' } },
        { op: 'insert', path: '/历代记忆摘要/-', value: { 世代编号: 1, 身体姓名: '旧身', 详细词条名称: '第1世·旧身' } },
    ])}</JSONPatch></UpdateVariable>`;
    const deadStored = { 主角: { 种族: '人类', 职业: [], 生命值: { 当前: 0 } }, 世界: { 地点: '暗巷' } };
    const liveStored = { 主角: { 种族: '高等精灵', 职业: ['法师'], 生命值: { 当前: 535 } }, 世界: { 地点: '彩玉区出租屋' } };
    const records = confirmedCarrierRecords([
        { is_user: false, mes: `${card}${candidatePatch}`, stat_data: deadStored },
        { is_user: true, mes: '确认换身', stat_data: deadStored },
        { is_user: false, mes: commitPatch, stat_data: liveStored },
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0].profile.姓名, '芙莉莲');
});

test('schema recovery still rejects text-only claims without a stored death-to-life transition', () => {
    const noStoredEvidence = [
        { is_user: false, mes: carrierCard },
        { is_user: true, mes: '确认换身' },
        { is_user: false, mes: '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' },
    ];
    assert.equal(confirmedCarrierRecords(noStoredEvidence).length, 0);
});

test('cross-life money keeps the exact pre-confirmation balance', () => {
    const messages = confirmedFixture();
    messages[0].stat_data.主角.金钱 = 123456;
    messages[1].stat_data = structuredClone(messages[0].stat_data);
    messages[2].stat_data.主角.金钱 = 800;
    const record = confirmedCarrierRecords(messages)[0];
    assert.deepEqual(crossLifeMoneyTransition(messages, record), {
        inheritedMoney: 123456,
        committedMoney: 800,
        currentMoney: 800,
        adjustedMoney: 123456,
        needsRestore: true,
    });
    assert.equal(normalizedMoney('1e122'), 1e122);
    assert.equal(normalizedMoney('不是金额'), null);
});

test('narrative death and confirmation without real state cannot fabricate a commit', () => {
    const noHistoryCard = actualCarrierCardVariant.replace(/<b>===== 历代经历记忆 =====<\/b>[\s\S]*?<b>===== 不继承声明 =====<\/b>/, '<b>===== 不继承声明 =====</b>');
    const lives = rebuildConversationLives([
        { is_user: true, mes: '姓名: 江书宇\n身份: 异世界来客\n性别: 男\n年龄: 16岁' },
        { is_user: false, mes: '<summary>江书宇来到铁炉堡。</summary>后来被流矢贯穿头颅，当场死亡。' },
        { is_user: false, mes: noHistoryCard },
        { is_user: true, mes: '确认换身' },
    ]);
    assert.deepEqual(lives, []);
});

test('manual current-body data cannot overwrite recovered life records with an empty list', () => {
    const recovered = [{ generation: 1, name: '江书宇', summary: '在铁炉堡死亡。' }];
    assert.deepEqual(mergeLifeRecords([], recovered).map(item => item.title), ['第1世·江书宇']);
});

test('currentBodySummary lets a confirmed carrier override stale identity but keeps live status', () => {
    const confirmed = parseCarrierCard(extractCarrierCards(carrierCard)[0]);
    const result = currentBodySummary({
        主角: {
            载体档案: { 姓名: '江书宇', 年龄: '16岁', 当前地点与处境: '旧地点' },
            种族: '人类（异世界来客）', 身份: [], 职业: ['裁缝学徒'],
            生命值: { 当前: 206, 上限: { _基础: 200, 额外: 13 } }, 状态效果: {},
        },
        世界: { 地点: '铁炉堡工匠区裁缝铺二楼' },
    }, confirmed, { preferSupplemental: true });
    const rows = Object.fromEntries(result.rows);
    assert.equal(result.name, '若莎·阿泽恩（Zhosha Adzern）');
    assert.equal(rows.年龄, '15岁｜外貌年龄15岁');
    assert.equal(rows.性别, '女');
    assert.equal(rows.职业, '铁炉堡裁缝铺学徒');
    assert.equal(rows.地点, '铁炉堡工匠区裁缝铺二楼');
    assert.equal(rows.健康, '生命值 206/213 · 无状态效果');
});

test('life history renders concise summaries and ignores protocol/template entries', () => {
    assert.deepEqual(lifeSummariesFromCarrierCard(extractCarrierCards(carrierCard)[0]), [{
        generation: 1,
        name: '江书宇',
        title: '第1世·江书宇',
        summary: '从现代中国穿越到铁炉堡，次日被盗匪流矢射杀。',
        source: 'confirmed-card',
    }]);
    const result = lifeHistorySummaries(
        confirmedFixture(),
        {},
        [
            { comment: '[历代记忆档案]【常驻规则】档案协议', content: '不是人生' },
            { comment: '[历代记忆档案]【模板·默认禁用】', content: '不是人生' },
        ],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].title, '第1世·江书宇');
});

test('life history includes chat-local plugin ledger records', () => {
    const result = lifeHistorySummaries([], {}, [], [{ generation: 2, name: '朵丽', title: '第2世·朵丽', summary: '在铁炉堡生活。' }]);
    assert.equal(result[0].title, '第2世·朵丽');
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
        身份: '旅人', 职业: '法师', 跨世金钱: '当前变量未提供', 地点: '旅店', 健康: '健康',
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
        身份: '无', 职业: '无（原世界学生）', 跨世金钱: '当前变量未提供', 地点: '城防值班室',
        健康: '生命值 206/206 · 无状态效果',
    });
});

test('currentBodySummary lets live injuries override a stale healthy carrier description', () => {
    const result = currentBodySummary({
        主角: {
            载体档案: { 姓名: '纳蕾', 伤病与健康: '身体健康，无伤病。' },
            生命值: { 当前: 391, 上限: { _基础: 413, 额外: 0 } },
            状态效果: { 小腿割伤: { 效果: '轻微渗血' } },
        },
    });
    const health = Object.fromEntries(result.rows).健康;
    assert.equal(health, '生命值 391/413 · 状态：小腿割伤');
});

test('statDataFromVariables reads object and JSON forms', () => {
    assert.deepEqual(statDataFromVariables({ stat_data: { 主角: { 等级: 2 } } }), { 主角: { 等级: 2 } });
    assert.deepEqual(statDataFromVariables({ stat_data: '{"主角":{"等级":3}}' }), { 主角: { 等级: 3 } });
});

test('statDataFromMessage supports SillyTavern storage fallbacks', () => {
    assert.deepEqual(statDataFromMessage({ extra: { variables: { stat_data: { 主角: { 等级: 4 } } } } }), { 主角: { 等级: 4 } });
    assert.deepEqual(statDataFromMessage({ variables: [{ stat_data: { 主角: { 等级: 7 } } }] }), { 主角: { 等级: 7 } });
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
