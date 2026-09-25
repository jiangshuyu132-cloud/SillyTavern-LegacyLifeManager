// Optional browser smoke test. Uses synthetic data only, never a user's server.
// PLAYWRIGHT_PATH may point to an already installed Playwright package.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set(['index.js','core.js','dossier.js','dossier-store.js','source-ledger.js','updater.js','opening.js','strict-protocol.js','mvu-adapter.js','style.css','test/fixtures/dual-dossier.html','test/fixtures/transactional-dossier.html']);
const server = createServer(async (req,res) => {
    const name = new URL(req.url,'http://localhost').pathname.slice(1) || 'test/fixtures/dual-dossier.html';
    if (!allowed.has(name)) {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type', name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/javascript');
    res.end(await readFile(resolve(root,name)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
if (process.argv.includes('--serve')) {
    console.log(`Synthetic QA fixture: http://127.0.0.1:${server.address().port}/`);
} else {
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
let browser;
try {
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1200,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByText('当前有效身体档案（动态主档·每轮完整注入）',{exact:true}).waitFor();
    await page.locator('.llm-sections summary').filter({hasText:'外貌详述'}).click();
    assert.match(await page.locator('.llm-sections').innerText(),/妆容：淡红唇色/);
    await page.locator('.llm-original-dossier > summary').click();
    await page.locator('.llm-original-dossier .llm-section > summary').filter({hasText:'外貌详述'}).click();
    assert.match(await page.locator('.llm-original-dossier').innerText(),/妆容：无/);
    assert.equal(await page.evaluate(()=>qaContext.extensionPrompts.legacy_life_manager_current_body.value.includes(qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.text)),true);
    await page.getByText('当前有效身体档案（动态主档·每轮完整注入）',{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:process.env.QA_SCREENSHOT || '/tmp/legacy-dual-dossier-qa.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#legacy-life-manager-root').evaluate(el=>el.scrollWidth<=el.clientWidth+2),true);
    assert.deepEqual(errors,[]);
    console.log('Browser QA passed: dynamic/original separation, prompt equality, narrow layout, no page errors.');
    await page.goto(`http://127.0.0.1:${server.address().port}/test/fixtures/transactional-dossier.html`);
    await page.locator('#legacy-life-manager-root').waitFor();
    await page.getByText('整理/重试待同步档案',{exact:true}).first().click();
    await page.waitForFunction(()=>qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.repairs.length===0);
    await page.evaluate(()=>qaReply('林晓涂好了淡红色唇膏。'));
    await page.waitForFunction(()=>qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.text.includes('妆容：淡红唇妆'));
    assert.equal(await page.evaluate(()=>qaContext.extensionPrompts.legacy_life_manager_current_body.value.includes(qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.text)),true);
    const beforeHide=await page.evaluate(()=>qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.text);
    await page.evaluate(()=>qaHide());
    assert.equal(await page.evaluate(()=>qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.text),beforeHide);
    await page.evaluate(()=>qaDeleteLast());
    await page.waitForFunction(()=>!qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.text.includes('淡红唇妆'));
    await page.evaluate(()=>qaReply('林晓涂好了淡红色唇膏。',true));
    await page.getByText('未接收项：模拟接口不可用',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>qaGate()),true);
    await page.evaluate(()=>{qaFail=false;});
    await page.getByText('整理/重试待同步档案',{exact:true}).first().click();
    await page.waitForFunction(()=>qaContext.chatMetadata.legacy_life_manager.currentBody.dynamicDossier.repairs.length===0);
    assert.equal(await page.evaluate(()=>qaGate()),false);
    assert.equal(await page.evaluate(()=>qaRequests.every(r=>r.systemPrompt.includes('人物档案整理器') && !r.prompt.includes('LegacyBodyUpdate'))),true);
    await page.screenshot({path:'/tmp/legacy-transactional-dossier-qa.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Browser QA passed: real event callbacks, automatic dedicated updater, hide preservation, deletion rollback, failure gate, manual retry, prompt version equality.');
} finally {
    await browser?.close();
    await new Promise(r=>server.close(r));
}
}
