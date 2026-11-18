import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkDuration} from '../src/browser-mail/work-duration.mjs';

for (const input of [undefined,null,'','   ','不限时','无时间限制','一直运行','unlimited','UNLIMITED','until stopped',' Until   stopped ']) {
  test('unlimited dedicated duration field: '+JSON.stringify(input),()=>assert.equal(parseWorkDuration(input),null));
}

for (const [input,expected] of [
  ['1小时',3600000],['5小时',18000000],['1.5小时',5400000],['90分钟',5400000],['2天',172800000],
  ['1 h',3600000],['5H',18000000],['1 hour',3600000],['1.5 hours',5400000],
  ['2m',120000],['1 minute',60000],['2 MINUTES',120000],['1 day',86400000],['2 DAYS',172800000],
  [' .5 小时 ',1800000],['0001.500小时',5400000],['0.001m',60],
  ['0.00001h',36],['0.0000003125day',27],['150119987579.0165m',9007199254740990],
]) {
  test('exact duration '+input,()=>assert.equal(parseWorkDuration(input),expected));
}

for (const input of ['8小时后提醒','工作1小时','1小时，目标50封','1小时30分钟','5h then stop','unlimited now',
  'until stopped after 8 hours','0小时','0.0h','-1h','NaN hours','Infinity h','1e3h','+1h','1.小时','1 seconds','5小时。',
  '0.000000000001天','0.00000001分钟','9007199254740991h','150119987579.0166m']) {
  test('reject non-exact or invalid duration '+input,()=>assert.throws(()=>parseWorkDuration(input),/WORK_DURATION_/));
}

for (const input of [0,1,-1,NaN,Infinity,true,false,{},[],new String('1h')]) {
  test('reject ambiguous non-text input '+String(input),()=>assert.throws(()=>parseWorkDuration(input),/MUST_BE_TEXT_OR_NULL/));
}

test('reminder wording is never mistaken for a duration even when it begins with a valid amount',()=>{
  assert.throws(()=>parseWorkDuration('8小时后提醒，继续运行'),/EXACT_POSITIVE_NUMBER_WITH_UNIT/);
  assert.throws(()=>parseWorkDuration('remind after 8 hours'),/EXACT_POSITIVE_NUMBER_WITH_UNIT/);
  assert.equal(parseWorkDuration('8小时'),28800000);
});
