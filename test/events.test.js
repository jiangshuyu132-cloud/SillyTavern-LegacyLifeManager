import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let ctx,book,saveCount,fetchCount,readbackOK=true,changeDuringRead=false;
globalThis.document={readyState:'loading',addEventListener(){},getElementById(){return null;},querySelector(){return null;}};
globalThis.SillyTavern={getContext:()=>ctx};
globalThis.toastr={info(){},warning(){},error(){},success(){}};
globalThis.confirm=()=>true;
globalThis.getVariables=opts=>{const index=opts.message_id==='latest'?ctx.chat.length-1:opts.message_id;return {stat_data:ctx.chat[index]?.stat_data};};
globalThis.updateVariablesWith=(fn,opts)=>{const index=opts.message_id==='latest'?ctx.chat.length-1:opts.message_id;const next=fn({stat_data:ctx.chat[index].stat_data});ctx.chat[index].stat_data=next.stat_data;};
globalThis.fetch=async()=>{fetchCount++;if(changeDuringRead)ctx.chatId='different-chat';return {ok:readbackOK,async json(){return structuredClone(book);}};};
const url=new URL('../index.js',import.meta.url);let source=await readFile(url,'utf8');source=source.replace(/from '(\.\/[^']+)'/g,(_all,path)=>`from '${new URL(path,url).href}'`);source+='\nexport {archivePendingLife,reconcileConversation,buildCurrentBodyPrompt,readEffectiveStatData,applyMoneyInheritance};';
const plugin=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const card='【当前载体人物设定开始】\n<div><b>世代编号：</b>第2世<br><b>姓名：</b>新身体<br></div>\n【当前载体人物设定结束】';
const draft='词条名称: 第1世·旧身体\n重要人物: 守卫\n重要经历：守住城门。';
function setup(){
 saveCount=0;fetchCount=0;readbackOK=true;changeDuringRead=false;book={entries:{}};
 const before={主角:{金钱:123456,载体档案:{姓名:'旧身体'},换身状态:{阶段:'等待确认',当前身体死亡已确认:true,当前世代编号:1,待确认人物卡:card,当前身体死亡信息:'已死亡',待归档人生词条:'',归档写入状态:'无待处理'}},历代记忆摘要:[]};
 const after={主角:{金钱:800,载体档案:{姓名:'新身体'},换身状态:{阶段:'当前身体生效',当前身体死亡已确认:false,当前世代编号:2,待确认人物卡:'',当前身体死亡信息:'',待归档人生词条:draft,归档写入状态:'待写入世界书'}},历代记忆摘要:[{世代编号:1,身体姓名:'旧身体',详细词条名称:'第1世·旧身体'}]};
 ctx={chatId:'test',chat:[{is_user:false,mes:card,stat_data:before},{is_user:true,mes:'确认换身'},{is_user:false,mes:'交接正文',stat_data:after}],chatMetadata:{world_info:'现有测试世界书'},extensionSettings:{},getWorldInfoNames:()=>['现有测试世界书'],getRequestHeaders:()=>({'Content-Type':'application/json'}),async loadWorldInfo(){return structuredClone(book);},async saveWorldInfo(_name,data){saveCount++;book=structuredClone(data);},saveMetadataDebounced(){},saveSettingsDebounced(){}};return after;
}
test('真实归档回调写入、后端回读后清理，重复点击不增词条',async()=>{
 setup();await plugin.archivePendingLife();assert.equal(saveCount,1);assert.equal(fetchCount,1);assert.equal(Object.keys(book.entries).length,1);assert.equal(ctx.chat[2].stat_data.主角.换身状态.待归档人生词条,'');await assert.rejects(plugin.archivePendingLife(),/有效待归档/);assert.equal(saveCount,1);
 const result=plugin.reconcileConversation();assert.equal(result.current.profile.姓名,'新身体');
});
test('确认换身后只继承一次旧身体金钱，后续消费不被刷新回滚',async()=>{
 setup();plugin.reconcileConversation();
 assert.equal(await plugin.applyMoneyInheritance(),true);
 assert.equal(ctx.chat[2].stat_data.主角.金钱,123456);
 assert.equal(Object.values(ctx.chatMetadata.legacy_life_manager.moneyInheritance)[0].status,'applied');
 ctx.chat[2].stat_data.主角.金钱=120000;
 assert.equal(await plugin.applyMoneyInheritance(),false);
 assert.equal(ctx.chat[2].stat_data.主角.金钱,120000);
});
test('后端回读失败保留草稿；重试同文分支也必须回读',async()=>{
 setup();readbackOK=false;await assert.rejects(plugin.archivePendingLife(),/后端回读未验证/);assert.equal(ctx.chat[2].stat_data.主角.换身状态.待归档人生词条,draft);assert.equal(saveCount,1);
 readbackOK=true;await plugin.archivePendingLife();assert.equal(saveCount,1);assert.equal(fetchCount,2);assert.equal(ctx.chat[2].stat_data.主角.换身状态.归档写入状态,'已写入世界书');
});
test('归档途中聊天切换停止清理，不污染新聊天',async()=>{
 setup();changeDuringRead=true;await assert.rejects(plugin.archivePendingLife(),/聊天或楼层改变/);assert.equal(ctx.chat[2].stat_data.主角.换身状态.待归档人生词条,draft);
});
test('同名异文冲突不保存不清理',async()=>{
 setup();book={entries:{7:{uid:7,comment:'[历代记忆档案]第1世·旧身体',content:'不同记录'}}};await assert.rejects(plugin.archivePendingLife(),/同名异文/);assert.equal(saveCount,0);assert.equal(ctx.chat[2].stat_data.主角.换身状态.待归档人生词条,draft);
});
test('缺少真实提交链即使有草稿也不归档',async()=>{
 setup();ctx.chat[1].mes='发送“确认换身”，正式接管';await assert.rejects(plugin.archivePendingLife(),/缺少可核实/);assert.equal(saveCount,0);assert.equal(ctx.chat[2].stat_data.主角.换身状态.待归档人生词条,draft);
});
test('旧插件账本首次升级永久备份，不覆写MVU与世界书',()=>{
 setup();ctx.chat=[];ctx.chatMetadata.legacy_life_manager={version:5,currentBody:{profile:{姓名:'未核实旧人物'}},lives:[{generation:1,name:'旧人'}],backups:[]};plugin.reconcileConversation();const data=ctx.chatMetadata.legacy_life_manager;assert.equal(data.currentBody,null);assert.equal(data.legacyMigrationBackup.data.currentBody.profile.姓名,'未核实旧人物');assert.equal(data.legacyMigrationBackup.data.lives[0].name,'旧人');assert.equal(saveCount,0);
});
test('确认首轮只注入金钱保护，普通下一轮恢复完整当前身体档案',()=>{
 const after=setup();const body={profile:{姓名:'新身体'},rawCard:card,text:card};assert.match(plugin.buildCurrentBodyPrompt(body,after,'compact').prompt,/<legacy_life_money_continuity>/);ctx.chat.push({is_user:true,mes:'观察门口'});assert.match(plugin.buildCurrentBodyPrompt(body,after,'compact').prompt,/<legacy_life_current_body\b/);
});
test('严格主档案每轮发送完整人物卡并保留正文变量模块',()=>{
 const after=setup();ctx.chat.push({is_user:true,mes:'观察门口'});const body={profile:{姓名:'新身体'},rawCard:card,text:card};const prompt=plugin.buildCurrentBodyPrompt(body,after,'strict');
 assert.equal(prompt.effectiveMode,'严格主档案·每轮完整');
 assert.match(prompt.prompt,/confirmed-plugin-dossier-first/);
 assert.match(prompt.prompt,/必须同时读取本插件档案与正文已有的 <status_current_variables>\/stat_data/);
 assert.match(prompt.prompt,/物品数量、背包、装备、资产、任务、新闻、地图、人物是否在场/);
 assert.match(prompt.prompt,/【当前载体人物设定开始】/);
});
test('刷新时用可信备份恢复缺少提交层快照的有效换身，删除确认层仍撤销',()=>{
 const after=setup();plugin.reconcileConversation();const data=ctx.chatMetadata.legacy_life_manager;
 data.backups=[{at:new Date().toISOString(),reason:'测试安全备份',currentBody:structuredClone(data.currentBody),lives:structuredClone(data.lives)}];data.currentBody=null;data.lives=[];
 const waiting={阶段:'等待确认',当前世代编号:1,当前身体死亡已确认:true,当前身体死亡信息:'已死亡',待确认人物卡:'【候选】新身体。详细设定见正文候选卡。',待归档人生词条:'',归档写入状态:'无待处理'};
 const active={阶段:'当前身体生效',当前世代编号:2,当前身体死亡已确认:false,当前身体死亡信息:'',待确认人物卡:'',待归档人生词条:draft,归档写入状态:'待写入世界书'};
 ctx.chat[0].stat_data={主角:{生命值:{当前:0}}};ctx.chat[0].mes=card+`<UpdateVariable><JSONPatch>${JSON.stringify([{op:'replace',path:'/主角/换身状态',value:waiting}])}</JSONPatch></UpdateVariable>`;
 delete ctx.chat[2].stat_data;ctx.chat[2].mes=`<UpdateVariable><JSONPatch>${JSON.stringify([{op:'replace',path:'/主角/换身状态',value:active},{op:'replace',path:'/主角/载体档案',value:{姓名:'新身体'}},{op:'insert',path:'/历代记忆摘要/-',value:{世代编号:1,身体姓名:'旧身体',详细词条名称:'第1世·旧身体'}}])}</JSONPatch></UpdateVariable>`;
 ctx.chat.push({is_user:true,mes:'继续生活'},{is_user:false,mes:'后续正文',stat_data:{主角:{载体档案:{姓名:'新身体'},生命值:{当前:100}}}});
 const restored=plugin.reconcileConversation();assert.equal(restored.current.profile.姓名,'新身体');assert.equal(ctx.chatMetadata.legacy_life_manager.currentBody.profile.姓名,'新身体');
 ctx.chat.splice(1,1);const cleared=plugin.reconcileConversation();assert.equal(cleared.cleared,true);assert.equal(ctx.chatMetadata.legacy_life_manager.currentBody,null);
});
