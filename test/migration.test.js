import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmationGate,commitGate,archiveGate,protocolTimeline,applyProtocolPatch,specialGeneration} from '../strict-protocol.js';
import {confirmedCarrierRecords,upsertArchive,mergeLifeRecords,compactLifeIndex,currentBehaviorProfile,responseSummaries} from '../core.js';
import {createMvuAdapter} from '../mvu-adapter.js';
const card='【当前载体人物设定开始】\n<div><b>世代编号：</b>第2世<br><b>姓名：</b>新身体<br></div>\n【当前载体人物设定结束】';
const draft='词条名称: 第1世·旧身体\n重要经历：守住城门。';
function fixture(){
 const before={主角:{载体档案:{姓名:'旧身体'},换身状态:{阶段:'等待确认',当前身体死亡已确认:true,当前世代编号:1,待确认人物卡:card,当前身体死亡信息:'死亡成立',待归档人生词条:'',归档写入状态:'无待处理'}},历代记忆摘要:[],世界:{时间:'当天'}};
 const after={主角:{载体档案:{姓名:'新身体'},换身状态:{阶段:'当前身体生效',当前身体死亡已确认:false,当前世代编号:2,待确认人物卡:'',当前身体死亡信息:'',待归档人生词条:draft,归档写入状态:'待写入世界书'}},历代记忆摘要:[{世代编号:1,身体姓名:'旧身体',详细词条名称:'第1世·旧身体'}],世界:{时间:'当天'}};
 return {before,after,chat:[{is_user:false,mes:card,stat_data:before},{is_user:true,mes:'确认换身'},{is_user:false,mes:'脚底传来石板的凉意。',stat_data:after}]};
}
test('精确确认允许首尾空白，拒绝引号、长句、角色复述和错误口令',()=>{
 const {before}=fixture();for(const text of ['确认换身',' \n确认换身\t'])assert.equal(confirmationGate(before,text),true);
 for(const text of ['“确认换身”','确认换身。','发送“确认换身”，正式接管','主角说：确认换身','确认换体','<discussion_record>确认换身</discussion_record>'])assert.equal(confirmationGate(before,text),false);
});
test('死亡、阶段、候选、整数世代缺一项均不能确认',()=>{
 for(const [key,value] of [['阶段','当前身体生效'],['当前身体死亡已确认',false],['待确认人物卡',''],['当前世代编号','1'],['当前世代编号',0]]){
  const {before}=fixture();before.主角.换身状态[key]=value;assert.equal(confirmationGate(before,'确认换身'),false,key);
 }
});
test('未落盘旧草稿阻止下一次提交，草稿原样保留',()=>{
 const {before}=fixture();before.主角.换身状态.待归档人生词条='旧草稿';before.主角.换身状态.归档写入状态='待写入世界书';assert.equal(confirmationGate(before,'确认换身'),false);assert.equal(before.主角.换身状态.待归档人生词条,'旧草稿');
});
test('真实MVU确认前后状态成立后才接管，裸口令不提前入档',()=>{
 const {chat}=fixture();assert.equal(confirmedCarrierRecords(chat.slice(0,2)).length,0);assert.equal(confirmedCarrierRecords(chat).length,1);
});
test('候选修改或废弃后旧卡不能接管',()=>{
 const {chat,before}=fixture();before.主角.换身状态.待确认人物卡=card.replace('新身体','改选身体');assert.equal(confirmedCarrierRecords(chat).length,0);
 before.主角.换身状态.待确认人物卡='';assert.equal(confirmedCarrierRecords(chat).length,0);
});
test('重复确认不新增记录，删除提交回复则撤销记录',()=>{
 const {chat}=fixture();chat.push({is_user:true,mes:'确认换身'},{is_user:false,mes:'不重复接管'});assert.equal(confirmedCarrierRecords(chat).length,1);chat.splice(2,1);assert.equal(confirmedCarrierRecords(chat).length,0);
});
test('仅正文JSONPatch即使完整也不冒充运行时已经提交',()=>{
 const {chat,after}=fixture();chat[2]={is_user:false,mes:`<UpdateVariable><JSONPatch>${JSON.stringify([{op:'replace',path:'/主角',value:after.主角},{op:'replace',path:'/历代记忆摘要',value:after.历代记忆摘要}])}</JSONPatch></UpdateVariable>`};assert.equal(confirmedCarrierRecords(chat).length,0);
});
test('归档清理不会使已确认载体消失',()=>{
 const {chat,after}=fixture();after.主角.换身状态.待归档人生词条='';after.主角.换身状态.归档写入状态='已写入世界书';assert.equal(confirmedCarrierRecords(chat).length,1);assert.equal(archiveGate(after),null);
});
test('错误加代、重复索引、改写旧索引、未清理候选不通过提交核对',()=>{
 for(const mutate of [a=>a.主角.换身状态.当前世代编号++,a=>a.历代记忆摘要.push(a.历代记忆摘要[0]),a=>a.主角.换身状态.待确认人物卡=card,a=>a.历代记忆摘要[0].身体姓名='他人']){
 const {before,after}=fixture();mutate(after);assert.equal(commitGate(before,after,{姓名:'新身体'},2),false);
 }
 const {before,after}=fixture();before.历代记忆摘要=[{世代编号:0,身体姓名:'不可改'}];assert.equal(commitGate(before,after,{姓名:'新身体'},2),false);
});
test('讨论候选和讨论回复不能形成接管记录或本世摘要',()=>{
 const {chat}=fixture();chat[0].mes='<discussion_record>'+card+'</discussion_record>';assert.equal(confirmedCarrierRecords(chat).length,0);
 assert.deepEqual(responseSummaries([{is_user:false,mes:'<discussion_record><summary>试写胜利</summary></discussion_record>'}]),[]);
});
test('消息快照已经包含delta结果，不重复扣除资源；后续补丁按方言回放',()=>{
 const patch='<UpdateVariable><JSONPatch>[{"op":"delta","path":"/主角/HP","value":-2}]</JSONPatch></UpdateVariable>';
 const result=protocolTimeline([{is_user:false,mes:patch,stat_data:{主角:{HP:8}}},{is_user:false,mes:patch}]);assert.equal(result[0].主角.HP,8);assert.equal(result[1].主角.HP,6);
});
test('用户引述和代码围栏内示例不应用为真实补丁',()=>{
 const patch='<UpdateVariable><JSONPatch>[{"op":"replace","path":"/主角/HP","value":0}]</JSONPatch></UpdateVariable>';
 const result=protocolTimeline([{is_user:false,stat_data:{主角:{HP:8}}},{is_user:true,mes:patch},{is_user:false,mes:'```xml\n'+patch+'\n```'}]);assert.equal(result.at(-1).主角.HP,8);
});
test('兼容insert/delta/move/remove与最新动态别名，并阻止原型写入',()=>{
 const state={主角:{HP:8},历代记忆摘要:[]};
 for(const op of [{op:'delta',path:'/最新动态/HP',value:-2},{op:'insert',path:'/历代记忆摘要/-',value:{世代编号:1}},{op:'move',from:'/主角/HP',to:'/主角/生命'},{op:'remove',path:'/历代记忆摘要/0'},{op:'replace',path:'/主角/__proto__/polluted',value:true}])applyProtocolPatch(state,op);
 assert.deepEqual(state,{主角:{生命:6},历代记忆摘要:[]});assert.equal({}.polluted,undefined);
});
test('归档门槛要求当前世代之前唯一索引与有效草稿',()=>{
 const {after}=fixture();assert.deepEqual(archiveGate(after),{draft,title:'第1世·旧身体',generation:1});after.历代记忆摘要.push(after.历代记忆摘要[0]);assert.equal(archiveGate(after),null);
});
test('世界书同文去重、异文拒绝、同世异名拒绝、UID冲突回避',()=>{
 const book={entries:{9:{uid:0,comment:'别的设定',content:'保留'}}};const a=upsertArchive(book,{title:'第1世·旧身体',content:draft,keywords:['旧身体']});assert.equal(a.uid,1);assert.deepEqual(book.entries[9],{uid:0,comment:'别的设定',content:'保留'});
 assert.equal(upsertArchive(a.book,{title:'第1世·旧身体',content:draft,keywords:[]}).status,'duplicate');assert.equal(upsertArchive(a.book,{title:'第1世·旧身体',content:'不同',keywords:[]}).status,'conflict');assert.equal(upsertArchive(a.book,{title:'第1世·他人',content:'不同',keywords:[]}).status,'conflict');
});
test('同世异人不因更长摘要覆盖，冲突内容不注入',()=>{
 const lives=mergeLifeRecords([{generation:1,name:'甲',summary:'旧经历'}],[{generation:1,name:'乙',summary:'更长更长的另一经历'}]);assert.equal(lives[0].conflict,true);assert.equal(compactLifeIndex(lives),'');
});
test('人格精确字段映射与当前技能优先，不继承卡中旧技能',()=>{
 const result=currentBehaviorProfile('<b>当前技能与能力：</b>旧能力<br>',{主角:{载体档案:{思维方式与认知边界:'按当前身体判断'},技能:{新技能:{描述:'本世技能'}}}});
 assert.match(JSON.stringify(result),/按当前身体判断/);assert.match(JSON.stringify(result),/新技能/);assert.doesNotMatch(JSON.stringify(result),/旧能力/);
});
test('两项归档状态在同一精确消息更新中清理，无关字段保留',async()=>{
 const {after}=fixture();let vars={stat_data:after,unrelated:42};let calls=0;
 const adapter=createMvuAdapter({env:{updateVariablesWith(fn,opts){assert.deepEqual(opts,{type:'message',message_id:2});calls++;vars=fn(vars);}},getContext:()=>({chat:[{},{},{}]}),getLatestMessageIndex:()=>2});
 await adapter.completeArchive({messageIndex:2,chatId:'x',draft,generation:1,assertContext(){}});assert.equal(calls,1);assert.equal(vars.unrelated,42);assert.equal(vars.stat_data.主角.换身状态.待归档人生词条,'');assert.equal(vars.stat_data.主角.换身状态.归档写入状态,'已写入世界书');
});
test('归档中草稿变化或聊天变化不清理新状态',async()=>{
 for(const contextChanged of [false,true]){
  const {after}=fixture();if(!contextChanged)after.主角.换身状态.待归档人生词条='新草稿';let vars={stat_data:after};
  const adapter=createMvuAdapter({env:{updateVariablesWith(fn){vars=fn(vars);}},getContext:()=>({chat:[]}),getLatestMessageIndex:()=>2});
  await assert.rejects(adapter.completeArchive({messageIndex:2,draft,generation:1,assertContext(){if(contextChanged)throw Error('聊天已切换');}}));assert.equal(vars.stat_data.主角.换身状态.归档写入状态,'待写入世界书');
 }
});
test('仅支持latest旧接口时保留草稿并报出明确限制',async()=>{
 let touched=false;const adapter=createMvuAdapter({env:{setMessageVar(){touched=true;}},getContext:()=>({chat:[]}),getLatestMessageIndex:()=>2});await assert.rejects(adapter.completeArchive({messageIndex:2,draft,generation:1,assertContext(){}}),/缺少按消息地址/);assert.equal(touched,false);
});
test('等待、候选、确认首轮和讨论暂停；下一玩家回合恢复',()=>{
 const {before,after,chat}=fixture();assert.ok(specialGeneration(chat.slice(0,1),before));assert.ok(specialGeneration(chat,after));assert.equal(specialGeneration([...chat,{is_user:true,mes:'观察门口'}],after),'');assert.ok(specialGeneration([{is_user:true,mes:'<discussion_record>讨论</discussion_record>'}],after));
});
