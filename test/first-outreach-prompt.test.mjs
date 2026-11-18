import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDraftPrompt, firstOutreachEligibility, selectOutreachProfile} from '../src/import.js';

const lead = (extra = {}) => ({company:'Example Studio',website:'https://studio.example.test',email:'hello@studio.example.test',country:'Example',purpose:'outreach',buyerType:'project buyer',need:'The published event collection includes artificial floral installations.',evidence:'The event catalogue lists floral installations; hello@studio.example.test is published on the contact page.',sourceUrl:'https://studio.example.test/catalogue',sourceDate:'2026-11-18',contactStatus:'not contacted',...extra});
const config = (extra = {}) => ({brand:{name:'Example Seller',products:['artificial flowers'],verifiedFacts:['Stems are 60 cm long.']},draftingPolicy:{mode:'product-evidence-review'},...extra});
const data = (prompt, name) => JSON.parse(prompt.split('\n').find(line => line.startsWith(name+'=')).slice(name.length+1));

test('physical seller data selects product details without assuming audience from industry', () => {
  const profile=selectOutreachProfile(lead(),config());
  assert.equal(profile.offerType,'physical');
  assert.equal(profile.audience,'b2b');
  assert.equal(selectOutreachProfile(lead({buyerType:undefined}),config()).audience,'unknown');
  assert.equal(profile.buyerAngle,'project');
  assert.match(buildDraftPrompt(lead(),config()),/physical offers use a supported material, size, specification or sample option/);
});

test('digital and service offers use actual seller context, not buyer product labels', () => {
  assert.equal(selectOutreachProfile(lead(),config({brand:{products:['downloadable digital templates']}})).offerType,'digital');
  assert.equal(selectOutreachProfile(lead(),config({brand:{services:['website operations services']}})).offerType,'service');
  assert.equal(selectOutreachProfile(lead(),config({brand:{products:['artificial flowers'],services:['design services']}})).offerType,'mixed');
  assert.equal(selectOutreachProfile(lead({need:'A software company sells flowers.'}),config({brand:{products:['unclassified item']}})).offerType,'unknown');
});

test('explicit business profile wins over inferred product and target buyer labels', () => {
  const profile=selectOutreachProfile(lead(),config({business:{audience:'B2C',offerType:'digital',buyerTypes:['wholesalers']}}));
  assert.equal(profile.audience,'b2c');
  assert.equal(profile.offerType,'digital');
  assert.equal(profile.audienceSource,'business.audience');
  assert.equal(profile.offerTypeSource,'business.offerType');
});

test('explicit unknown or unsupported values do not silently fall back to B2B or goods', () => {
  const profile=selectOutreachProfile(lead(),config({business:{audience:'unknown',offerType:'unknown',buyerTypes:['retailers']}}));
  assert.equal(profile.audience,'unknown');
  assert.equal(profile.offerType,'unknown');
  const prompt=buildDraftPrompt(lead(),config({brand:{products:['unclassified item']}}));
  assert.equal(data(prompt,'OUTREACH_PROFILE').offerType,'unknown');
  assert.match(prompt,/Unknown stays unknown/);
});

test('buyer target categories infer audience conservatively but do not invent this buyer role', () => {
  const profile=selectOutreachProfile(lead({buyerType:undefined}),config({research:{buyerTypes:['wholesalers','retailers']}}));
  assert.equal(profile.audience,'b2b');
  assert.equal(profile.buyerAngle,'unknown');
  assert.equal(selectOutreachProfile(lead(),config({research:{buyerTypes:['business buyers','consumers']}})).audience,'mixed');
});

test('individual/B2C adaptation holds missing contact basis and never treats a public email as that basis', () => {
  const cfg=config({business:{audience:'B2C',offerType:'service'}});
  assert.equal(data(buildDraftPrompt(lead(),cfg),'FIRST_OUTREACH_ELIGIBILITY').status,'hold');
  const eligible=lead({recipientType:'individual',contactBasis:'Verified request to receive introductory service information.'});
  const prompt=buildDraftPrompt(eligible,cfg);
  assert.equal(data(prompt,'FIRST_OUTREACH_ELIGIBILITY').status,'eligible-for-drafting');
  assert.match(prompt,/publicly listed email does not establish that basis/);
  assert.match(prompt,/does not change the existing company-record importer/);
});

test('prior contacts, refusals and unsubscribe records are held out of first drafts', () => {
  for (const status of ['contacted','already contacted','已联系','refused','unsubscribe','do not contact','退订']) {
    const result=firstOutreachEligibility(lead({contactStatus:status}));
    assert.equal(result.status,'hold',status);
    assert.ok(result.reasons.length,status);
  }
  for (const status of ['not contacted','not_contacted','uncontacted','未联系']) {
    assert.equal(firstOutreachEligibility(lead({contactStatus:status})).status,'eligible-for-drafting',status);
  }
});

test('missing identity, source or fit leads to review notes rather than recipient copy', () => {
  for (const extra of [{company:''},{email:''},{need:''},{evidence:''},{sourceUrl:''},{fitVerified:false},{recipientIdentityVerified:false}]) {
    assert.equal(firstOutreachEligibility(lead(extra)).status,'hold',JSON.stringify(extra));
  }
  const prompt=buildDraftPrompt(lead({fitVerified:false}),config());
  assert.match(prompt,/an empty subject\/english\/chinese/);
  assert.match(prompt,/missing facts in reviewNotes/);
});

test('first message includes customer and seller evidence without using inbound enquiry as an opener', () => {
  const prompt=buildDraftPrompt(lead({inboundContext:'SECRET INBOUND ENQUIRY',threadId:'SECRET-THREAD',raw:{contactRecords:['No historic outreach'],buyerType:'retailer'}}),config());
  const prospect=data(prompt,'PROSPECT_DATA');
  assert.equal(prospect.email,'hello@studio.example.test');
  assert.equal(prospect.sourceUrl,'https://studio.example.test/catalogue');
  assert.deepEqual(prospect.contactRecords,['No historic outreach']);
  assert.equal(Object.hasOwn(prospect,'inboundContext'),false);
  assert.equal(Object.hasOwn(prospect,'threadId'),false);
  assert.doesNotMatch(prompt,/SECRET INBOUND|SECRET-THREAD/);
  assert.deepEqual(data(prompt,'BRAND_AND_PRODUCT_DATA').verifiedFacts,['Stems are 60 cm long.']);
  // Keep the final JSON line parseable by the existing draft adapter.
  assert.deepEqual(JSON.parse(prompt.split('PROSPECT_DATA=')[1]),prospect);
});

test('first-draft contract contains one question, correct length and separated bilingual review fields', () => {
  const prompt=buildDraftPrompt(lead(),config());
  assert.match(prompt,/70–120 words excluding signature/);
  assert.match(prompt,/exactly one low-effort question and one CTA/);
  assert.match(prompt,/no fake Re:/);
  assert.match(prompt,/name-swap test/);
  assert.match(prompt,/batch comparison pending/);
  assert.match(prompt,/"subject":"English subject","english":"English body","chinese":/);
  assert.match(prompt,/"personalizationBasis":/);
  assert.match(prompt,/Evidence and review notes must stay outside english and chinese/);
  assert.doesNotMatch(prompt,/60–100 words/);
});

test('drafting prompt does not activate sending and distinguishes facts from hypotheses', () => {
  const prompt=buildDraftPrompt(lead(),config());
  assert.match(prompt,/Draft only: do not log into mailboxes, reply to enquiries, schedule or send messages/);
  assert.doesNotMatch(prompt,/click Send|enqueue\(|schedule at|send automatically|POST \/send/i);
  assert.match(prompt,/hypotheses, not facts or purchase plans/);
  assert.match(prompt,/Never turn an unverified price, inventory, MOQ, lead time, freight cost, certification or outcome into a promise/);
});

test('100-source prerequisite activates only when explicitly selected upstream', () => {
  const product=buildDraftPrompt(lead(),config({playbook:{reviewedSources:3}}));
  assert.equal(data(product,'APPROVED_WRITING_PLAYBOOK'),null);
  assert.match(product,/No explicit hundred-source-playbook gate is active/);
  const unspecified=buildDraftPrompt(lead(),{brand:{products:['artificial flowers']}});
  assert.equal(data(unspecified,'DRAFTING_MODE'),'unspecified');
  assert.match(unspecified,/No explicit hundred-source-playbook gate is active/);
  const learning=buildDraftPrompt(lead(),config({draftingPolicy:{mode:'hundred-source-playbook'},playbook:{reviewedSources:3,approved:false}}));
  assert.deepEqual(data(learning,'APPROVED_WRITING_PLAYBOOK'),{reviewedSources:3,approved:false});
  assert.match(learning,/If 100 reviewed sources and upstream approval are not evidenced/);
  assert.match(learning,/verified count and gap/);
  assert.doesNotMatch(learning,/No explicit hundred-source-playbook gate is active/);
});

test('reply retains supplied inbound context and original length without the first-outreach route', () => {
  const prompt=buildDraftPrompt(lead({purpose:'reply',inboundContext:'Please confirm dimensions.',threadId:'thread-test'}),config());
  assert.match(prompt,/separate reply workflow/);
  assert.match(prompt,/60–100 words/);
  assert.equal(data(prompt,'PROSPECT_DATA').inboundContext,'Please confirm dimensions.');
  assert.equal(data(prompt,'PROSPECT_DATA').threadId,'thread-test');
  assert.doesNotMatch(prompt,/OUTREACH_PROFILE=|FIRST_OUTREACH_ELIGIBILITY=|70–120 words|name-swap test/);
});
