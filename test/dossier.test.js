import test from 'node:test';
import assert from 'node:assert/strict';
import { carrierCardSections } from '../core.js';
import { dossierBodyId, resolveDynamicDossier, dossierUpdateInstructions, narrativeEvidence } from '../dossier.js';

export const sampleCard = `— 当前形态基础 —
姓名：测试角色
年龄：28
种族：人类
职业：画师
性格与价值观：耐心，重视事实。
— 外貌详述 —
头发：黑色长发，发尾微卷。
面容：自然肤色，左眉有一颗小痣。
妆容：无
— 声音特征 —
音色：清亮
— 气味特征 —
自然体味：淡淡皂香
— 卫生状况 —
全身卫生：干净
— 当前穿着 —
上衣：灰色棉衫
鞋子：黑色短靴
— 疾病 —
无已知疾病。
— 人生背景 —
出生与家庭：出生在河畔小城。
成长经历：成年后学习绘画。
— 自定义细节 —
习惯：随身携带小笔记本。`;

function body() { return { generation: 2, confirmationMessageIndex: -1, rawCard: sampleCard, text: sampleCard, profile: { 姓名: '测试角色' }, sections: carrierCardSections(sampleCard) }; }
function message(b, index, narrative, changes = []) {
    return { send_date: `source-${index}`, is_user: false, mes: `<gametxt>${narrative}</gametxt>\n<LegacyBodyUpdate>${JSON.stringify({ version: 1, bodyId: dossierBodyId(b), changes })}</LegacyBodyUpdate>` };
}
function set(section, field, value, evidence) { return { op: 'set', section, field, value, evidence }; }
function save(b, messages, stat = {}, options = {}) { const result = resolveDynamicDossier(b, messages, stat, options); b.dynamicDossier = result.state; return result; }
const makeup = set('外貌详述', '妆容', '淡红唇色，细眼线。', '她已经化好妆，唇色淡红，画了细眼线。');

test('动态档初始完整复制所有原板块，更新只改变指定字段', () => {
    const b = body(), original = structuredClone(b);
    const first = save(b, []);
    assert.deepEqual(first.sections.map(s => ({ title:s.title, content:s.content })), b.sections);
    const next = save(b, [message(b,0,makeup.evidence,[makeup])]);
    assert.match(next.text,/妆容：淡红唇色，细眼线/);
    assert.match(next.text,/左眉有一颗小痣/);
    assert.match(next.text,/随身携带小笔记本/);
    assert.equal(b.rawCard,original.rawCard);
    assert.deepEqual(b.sections,original.sections);
    assert.equal(next.sections.length,original.sections.length);
});
test('多轮累计变化、无变化回执与卸妆不会丢失其他板块或复活旧妆', () => {
    const b = body(); const messages = [message(b,0,makeup.evidence,[makeup])];
    save(b,messages);
    const clothes = set('当前穿着','上衣','蓝色外套','她换上蓝色外套。');
    messages.push(message(b,1,clothes.evidence,[clothes]),message(b,2,'她继续走向广场。'));
    let result=save(b,messages);
    assert.match(result.text,/淡红唇色/); assert.match(result.text,/蓝色外套/); assert.match(result.text,/黑色短靴/);
    messages.push(message(b,3,'她将脸上的妆全部洗净。',[{...makeup,op:'remove',value:undefined,evidence:'她将脸上的妆全部洗净。'}]));
    result=save(b,messages);
    assert.match(result.text,/妆容：无（已移除/);assert.doesNotMatch(result.text,/淡红唇色/);assert.match(result.text,/蓝色外套/);
    assert.equal(resolveDynamicDossier(b,messages).changed,false);
});
test('隐藏、总结、重载与备份序列化仍保留完整动态档', () => {
    const b = body();const messages=[message(b,0,makeup.evidence,[makeup])];save(b,messages);
    const restored=JSON.parse(JSON.stringify(b));
    messages[0].is_system=true;
    assert.match(save(restored,messages).text,/淡红唇色/);
    messages[0].mes='楼层已总结';
    assert.match(save(restored,messages).text,/淡红唇色/);
    assert.match(save(restored,[]).text,/淡红唇色/);
});
test('不同身体绝不继承上一具身体的动态档', () => {
    const b=body();save(b,[message(b,0,makeup.evidence,[makeup])]);
    b.generation=3;
    assert.doesNotMatch(resolveDynamicDossier(b,[]).text,/淡红唇色/);
});
test('编辑、切换回复撤销原楼变化；删除只撤销本次可观察到消失的来源', () => {
    const b=body();const messages=[message(b,0,makeup.evidence,[makeup])];save(b,messages);
    messages[0].mes='<gametxt>她没有去化妆，而是回到了家。</gametxt>';
    assert.doesNotMatch(save(b,messages,{}, {retractChanged:true}).text,/淡红唇色/);
    messages[0]=message(b,0,makeup.evidence,[makeup]);save(b,messages);
    assert.doesNotMatch(save(b,[],{}, {retractDeleted:true}).text,/淡红唇色/);
    save(b,messages);save(b,[]); // independently absent due to summary
    assert.match(save(b,[],{}, {retractDeleted:true}).text,/淡红唇色/);
});
test('原锚点不在短聊天窗口内时，仍接受带正确身体标识的新变化',()=>{
    const b=body();b.confirmationMessageIndex=100;
    assert.match(save(b,[message(b,0,makeup.evidence,[makeup])]).text,/淡红唇色/);
});
test('原文、推理、未选滑动版本、代码块、NPC影像提示不被当更新依据',()=>{
    const b=body();const real=message(b,0,makeup.evidence,[makeup]);
    for(const mes of [`<think>${real.mes}</think>`,`<image>${real.mes}</image>`,`\`\`\`json\n${real.mes}\n\`\`\``]) {
        assert.equal(resolveDynamicDossier(b,[{mes}]).state.events.length,0);
    }
    assert.equal(resolveDynamicDossier(b,[{is_user:true,mes:real.mes}]).state.events.length,0);
    assert.equal(resolveDynamicDossier(b,[{mes:'平静的一天',extra:{reasoning:real.mes},swipes:[real.mes]}]).state.events.length,0);
    assert.doesNotMatch(narrativeEvidence({mes:`<gametxt>她走到门口。</gametxt><image>${makeup.evidence}</image>`}),/淡红/);
});
test('拒绝跨身体、无依据、身份偷换、危险字段与整块覆盖；原档保持完整',()=>{
    const variants=[{...makeup,evidence:'这一句不存在的正文依据'}, {...makeup,field:'姓名'}, {...makeup,field:'__proto__'}, {...makeup,field:'完整描述'}, {...makeup,section:'不存在'}];
    for (const change of variants) {
        const b=body();const result=save(b,[message(b,0,makeup.evidence,[change])]);
        assert.equal(result.state.events.length,0);assert.equal(result.state.issues.length,1);assert.equal(b.rawCard,sampleCard);
    }
    const b=body(),wrong=message({...b,generation:3},0,makeup.evidence,[makeup]);
    assert.equal(save(b,[wrong]).state.events.length,0);
});
test('不完整的流式更新不会覆盖上一次有效结果，完成后才接收',()=>{
    const b=body();const m=message(b,0,makeup.evidence,[makeup]);save(b,[m]);
    m.mes='<gametxt>她正在换衣。</gametxt><LegacyBodyUpdate>{';
    assert.match(save(b,[m]).text,/淡红唇色/);
    m.mes='';
    assert.doesNotMatch(save(b,[m],{}, {retractChanged:true}).text,/淡红唇色/);
});
test('旧正文没有更新块时显示待核对并将依据放入下一轮维护提示',()=>{
    const b=body();const result=save(b,[{mes:`<gametxt>${makeup.evidence}</gametxt>`}]);
    assert.equal(result.state.pending.sourceIndex,0);
    assert.doesNotMatch(result.text,/淡红唇色/);
    assert.match(dossierUpdateInstructions(b,result),/她已经化好妆/);
    assert.match(dossierUpdateInstructions(b,result),/旧正文补齐/);
    const next=save(b,[message(b,1,'她照着镜子。',[makeup])]);
    assert.match(next.text,/淡红唇色/);assert.equal(next.state.pending,null);
});
test('正文无gametxt标签、仅同步块折叠时仍正确验证；后续修正清除旧格式警告',()=>{
    const b=body();const m=message(b,1,makeup.evidence,[makeup]);
    m.mes=m.mes.replace('<gametxt>','').replace('</gametxt>','').replace('<LegacyBodyUpdate>','<details><summary>身体档案同步</summary><LegacyBodyUpdate>')+'</details>';
    const broken={mes:`${makeup.evidence}<LegacyBodyUpdate>{oops}</LegacyBodyUpdate>`};
    assert.equal(save(b,[broken]).state.issues.length,1);
    const result=save(b,[broken,m]);
    assert.match(result.text,/淡红唇色/);assert.equal(result.state.issues.length,0);
    assert.equal(save(b,[broken,m]).state.issues.length,0);
});
test('最新结构化字段进入正文同一主档，快照暂失时仍保留',()=>{
    const b=body();const stat={主角:{动态身体档案:{外貌详述:{头发:'剪短后的黑发'}},当前妆容:'淡妆'}};
    const result=save(b,[],stat);
    assert.match(result.text,/剪短后的黑发/);assert.doesNotMatch(result.text,/黑色长发/);assert.match(result.text,/左眉有一颗/);
    assert.match(save(b,[]).text,/剪短后的黑发/);
});
test('同轮详细正文比旧简写变量优先，变量真正后续改变时可解除妆容',()=>{
    const b=body();const stat={主角:{妆容:'无'}};save(b,[],stat);
    const messages=[message(b,0,makeup.evidence,[makeup])];
    assert.match(save(b,messages,stat).text,/淡红唇色/);
    stat.主角.妆容='卸妆后无妆';messages.push({mes:'她洗净了脸。'});
    assert.match(save(b,messages,stat).text,/卸妆后无妆/);assert.doesNotMatch(save(b,messages,stat).text,/淡红唇色/);
});
test('状态条不会删掉长疾病设定，明确清空状态时标注不再从旧病史复活',()=>{
    const b=body();b.rawCard=b.rawCard.replace('无已知疾病。','旧扭伤：运动时牵扯疼痛，需要支撑保护。');
    const result=save(b,[],{主角:{状态效果:{}}});
    assert.match(result.text,/运动时牵扯疼痛/);assert.match(result.text,/已移除项目不得复活/);
});

test('任意折叠标题不能抢走无标签正文；常见排版差异不误拒',()=>{
    const b=body();
    const change=set('外貌详述','妆容','淡红色唇妆','她涂好了淡红色唇膏。');
    const m=message(b,0,'她涂好了**淡红色**唇膏。',[change]);
    m.mes=m.mes.replace(/<\/?gametxt>/g,'').replace('<LegacyBodyUpdate>','<details><summary>档案更新记录</summary><LegacyBodyUpdate>')+'</details>';
    const result=save(b,[m]);
    assert.match(narrativeEvidence(m),/她涂好了/);
    assert.match(result.text,/妆容：淡红色唇妆/);
    assert.equal(result.state.issues.length,0);
});

test('一项引用失败不连带丢弃其他有效字段，且错误定位到具体字段',()=>{
    const b=body();
    const bad=set('当前穿着','上衣','蓝色外套','她穿好了蓝色外套。');
    const result=save(b,[message(b,0,makeup.evidence,[makeup,bad])]);
    assert.match(result.text,/妆容：淡红唇色/);
    assert.match(result.text,/上衣：灰色棉衫/);
    assert.match(result.state.issues.join('；'),/当前穿着.*上衣/);
    assert.equal(result.state.repairs.length,1);
    assert.match(dossierUpdateInstructions(b,result),/她穿好了蓝色外套/);
});

test('新一轮空回执不能假装修复旧拒绝项；隐藏后仍携带原文与错误项',()=>{
    const b=body();
    const bad={...makeup,evidence:'她的脸现在已经上妆。'};
    save(b,[message(b,0,makeup.evidence,[bad])]);
    let result=save(b,[message(b,1,'她走到了街口。')]);
    assert.equal(result.state.repairs.length,1);
    assert.match(dossierUpdateInstructions(b,result),/她已经化好妆/);
    assert.match(dossierUpdateInstructions(b,result),/她的脸现在已经上妆/);
    const correction=message(b,2,'她停下脚步。',[makeup]);
    result=save(b,[correction]);
    assert.match(result.text,/妆容：淡红唇色/);
    assert.equal(result.state.repairs.length,0);
    assert.equal(result.state.issues.length,0);
    assert.equal(save(b,[correction]).changed,false);
});

test('多条遗漏排队保留，空变化只能显式核对指定旧来源',()=>{
    const b=body();save(b,[]);
    const messages=[{send_date:'old-a',mes:'她说自己不打算化妆。'},{send_date:'old-b',mes:'她换上了蓝色外套。'}];
    let result=save(b,messages);
    assert.equal(result.state.repairs.length,2);
    const id=result.state.repairs[0].id;
    const receipt=message(b,2,'她继续走路。');
    receipt.mes=receipt.mes.replace('"changes":[]',`"changes":[],"reviewedSources":["${id}"]`);
    messages.push(receipt);
    result=save(b,messages);
    assert.equal(result.state.repairs.length,1);
    assert.match(result.state.repairs[0].text,/蓝色外套/);
    assert.equal(save(b,messages).changed,false);
});

test('升级即重读已被旧校验误拒的回复，不需要再生成一次',()=>{
    const b=body(),m=message(b,0,'她涂好了**淡红色**唇膏。',[set('外貌详述','妆容','淡红色唇妆','她涂好了淡红色唇膏。')]);
    b.dynamicDossier={version:1,bodyId:dossierBodyId(b),events:[],issues:['旧错误'],pending:{key:'source-0',sourceIndex:0,text:narrativeEvidence(m)}};
    const result=save(b,[m]);
    assert.match(result.text,/妆容：淡红色唇妆/);assert.equal(result.state.pending,null);
});

test('证据排版兼容不允许改写否定、数值、推理或把未来正文当旧证据',()=>{
    for(const actual of ['她没有涂好淡红色唇膏。','<think>她涂好了淡红色唇膏。</think>','<image>她涂好了淡红色唇膏。</image>']){
        const b=body();const c=set('外貌详述','妆容','淡红色唇妆','她涂好了淡红色唇膏。');
        assert.doesNotMatch(save(b,[message(b,0,actual,[c])]).text,/妆容：淡红色唇妆/);
    }
    const b=body();const early=message(b,0,'她坐在家里。',[makeup]);
    assert.doesNotMatch(save(b,[early,{mes:makeup.evidence}]).text,/妆容：淡红唇色/);
    assert.doesNotMatch(save(b,[]).text,/妆容：淡红唇色/);
});

test('显式删除或改写被引用的旧正文会撤销依赖它的补齐结果',()=>{
    for(const mode of ['edit','delete']){
        const b=body();const origin={send_date:'original-fact',mes:makeup.evidence};
        const reply=message(b,1,'她走到街口。',[makeup]);
        save(b,[origin,reply]);
        const messages=mode==='edit'?[{...origin,mes:'她并未化妆。'},reply]:[reply];
        const result=save(b,messages,{},mode==='edit'?{retractChanged:true}:{retractDeleted:true});
        assert.doesNotMatch(result.text,/妆容：淡红唇色/);
        assert.ok(result.state.repairs.length);
    }
});

test('待补齐队列不截断长原文，按完整来源分批注入且保留余项',()=>{
    const b=body();save(b,[]);
    const messages=Array.from({length:5},(_,i)=>({send_date:`backlog-${i}`,mes:`她考虑化妆${i}。`+'普通叙述。'.repeat(1000)}));
    const result=save(b,messages),prompt=dossierUpdateInstructions(b,result);
    assert.equal(result.state.repairs.length,5);
    assert.match(prompt,/共有 5 条待核对来源，本轮提供 3 条完整原文/);
    assert.ok(prompt.includes(messages[0].mes));
    assert.ok(!prompt.includes(messages[4].mes));
    assert.equal(save(b,messages).changed,false);
});

test('已核对字段在部分失败项被隐藏时不丢失',()=>{
    const b=body();const origin={send_date:'origin',mes:makeup.evidence};
    const failed=message(b,1,'她站在街边。',[makeup,set('当前穿着','上衣','蓝衣','不存在的依据正文')]);
    save(b,[origin,failed]);
    let result=save(b,[{...origin,is_system:true,mes:'已总结'},failed]);
    assert.match(result.text,/妆容：淡红唇色/);assert.ok(result.state.repairs.some(r=>r.rejected.some(e=>e.field==='上衣')));
    result=save(JSON.parse(JSON.stringify(b)),[]);
    assert.match(result.text,/妆容：淡红唇色/);
});

test('半截更新和未闭合推理不能污染下一轮正文证据',()=>{
    const b=body();
    for(const start of ['<LegacyBodyUpdate>{"evidence":"','<think>','<image>']){
        const partial={send_date:'partial',mes:'她坐在门口。'+start+makeup.evidence};
        assert.doesNotMatch(narrativeEvidence(partial),/化好妆/);
        assert.doesNotMatch(resolveDynamicDossier(b,[partial,message(b,1,'她继续休息。',[makeup])]).text,/妆容：淡红唇色/);
    }
});
