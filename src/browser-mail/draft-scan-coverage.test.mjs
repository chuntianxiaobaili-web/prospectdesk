import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserMailAdapter} from './browser-adapter.mjs';
import {MailSessionRunner} from './session-runner.mjs';

const accountId = 'sender@example.test';
const ids = ['1000000000000000000','1000000000000000001','1000000000000000002','1000000000000000003'];
const row = (index, draftId, {withRecipient = true, created = true} = {}) =>
  `  ${index} Value: 来自 我, 主题 Example, ${created ? '创建时间' : '投递时间'} 今天, ID: ${draftId}` +
    (withRecipient ? `\n    ${index + 1} text <recipient@example.test>` : '');

function fixture() {
  const mailbox = new BrowserMailAdapter({tab:{},accountId});
  mailbox.folder = async name => {
    assert.equal(name, '草稿');
    return [
      `0 AXWebArea Zoho Mail (${accountId})`,
      '  2 text 当前处于文件夹 草稿，',
      '  3 button 邮件总数 518',
      row(10,ids[0]),
      row(12,ids[1],{withRecipient:false}),
      row(14,ids[2]),
      row(16,ids[2]),
      row(18,ids[3]),
      row(20,'1000000000000000004',{created:false}),
    ].join('\n');
  };
  mailbox.countDrafts = async () => ({value:518,exact:true,source:'folder_details_total'});
  return mailbox;
}

test('current-page Zoho scan counts visible draft rows and binds only unique eligible IDs', async () => {
  const mailbox = fixture();
  const {drafts,coverage} = await mailbox.scanDrafts({limit:1,excludeDraftIds:[ids[0]],includeCoverage:true});
  assert.deepEqual(drafts.map(draft => draft.draftId), [ids[3]]);
  assert.deepEqual(coverage,{scope:'visible_draft_page',complete:false,observedRows:5,eligibleDrafts:1});
  assert.deepEqual((await mailbox.scanDrafts()).map(draft=>draft.draftId), [ids[0],ids[3]]);
});

test('explicit prepared references keep the array contract', async () => {
  const preparedRefs = [{accountId,draftId:ids[0]}];
  const mailbox = new BrowserMailAdapter({tab:{},accountId,preparedRefs});
  assert.deepEqual(await mailbox.scanDrafts({includeCoverage:true}),preparedRefs);
});

test('an exact folder count does not let a partially verified target start', async () => {
  const mailbox = fixture();
  const states = [];
  const runner = new MailSessionRunner({adapter:mailbox,target:2,store:{save(state){states.push(structuredClone(state));}}});
  await assert.rejects(runner.initialize({excludeDraftIds:[ids[0]]}),
    /DRAFT_SCAN_TARGET_EXCEEDS_COVERAGE: target=2, verified=1, scope=visible_draft_page/);
  const status = runner.status();
  assert.equal(status.phase,'halted');
  assert.equal(status.sent,0);
  assert.equal(status.scanCoverage.complete,false);
  assert.throws(()=>runner.start(),/Initialize the session before starting/);
  assert.deepEqual(states.at(-1).scanCoverage,status.scanCoverage);
});

test('a target within verified page coverage prepares with a separate mailbox count', async () => {
  const runner = new MailSessionRunner({adapter:fixture(),target:1,store:{save(){}}});
  const status = await runner.initialize({excludeDraftIds:[ids[0]]});
  assert.equal(status.phase,'ready');
  assert.equal(status.planned,1);
  assert.equal(status.sent,0);
  assert.equal(runner.state.records[0].ref.draftId,ids[3]);
  assert.equal(status.scanCoverage.complete,false);
  assert.deepEqual(status.initialMailboxCount,{value:518,exact:true,source:'folder_details_total'});
});
