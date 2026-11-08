import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteBuy, quoteSell, cashForQuantity, D, validAmount } from '../economy.js';
import { buildCandles } from '../public/detail.js';

test('buy and sell keep fees and reserves consistent', () => {
 const buy=quoteBuy('100000','100000','1000');
 assert.equal(buy.fee,'1.00000000');
 assert.equal(D(buy.nextCash).minus('100000').toFixed(8),'999.00000000');
 const sell=quoteSell(buy.nextCash,buy.nextTokens,buy.quantity);
 assert(D(sell.cash).lt('1000'));
 assert(D(sell.nextCash).gt(0));
 assert(D(sell.nextTokens).gt(0));
});
test('quantity quote covers requested amount', () => {
 const spend=cashForQuantity('100000','100000','100');
 assert(D(quoteBuy('100000','100000',spend).quantity).gte('100'));
});
test('invalid monetary precision is rejected', () => {
 assert.equal(validAmount('0.000000001'),false);
 assert.equal(validAmount('-1'),false);
 assert.equal(validAmount('Infinity'),false);
});
test('OHLC opens at first trade in its interval and preserves traded extremes', () => {
 const candles=buildCandles([{time:0,price:100},{time:10,price:110},{time:60,price:105},{time:70,price:120},{time:80,price:95}],60);
 assert.deepEqual(candles.map(({open,high,low,close})=>({open,high,low,close})),[{open:100,high:110,low:100,close:110},{open:105,high:120,low:95,close:95}]);
});
