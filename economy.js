import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });
export const D = value => new Decimal(String(value));
export const q = value => D(value).toDecimalPlaces(8, Decimal.ROUND_DOWN);
export const validAmount = (value, max = '1000000000') => {
  try { const n = D(value); return n.isFinite() && n.gt(0) && n.lte(max) && n.decimalPlaces() <= 8; }
  catch { return false; }
};
export function quoteBuy(poolCash, poolTokens, spend) {
  const cash = D(poolCash), tokens = D(poolTokens), total = q(spend);
  const fee = q(total.mul('0.001'));
  const net = total.minus(fee);
  const quantity = q(tokens.minus(cash.mul(tokens).div(cash.plus(net))));
  if (!quantity.gt(0) || !quantity.lt(tokens)) throw Error('Сумма слишком мала или велика');
  return { quantity: quantity.toFixed(8), cash: total.toFixed(8), fee: fee.toFixed(8), nextCash: q(cash.plus(net)).toFixed(8), nextTokens: q(tokens.minus(quantity)).toFixed(8) };
}
export function quoteSell(poolCash, poolTokens, amount) {
  const cash = D(poolCash), tokens = D(poolTokens), quantity = q(amount);
  const gross = q(cash.minus(cash.mul(tokens).div(tokens.plus(quantity))));
  const fee = q(gross.mul('0.001'));
  const received = q(gross.minus(fee));
  if (!received.gt(0) || !gross.lt(cash)) throw Error('Сумма слишком мала или велика');
  return { quantity: quantity.toFixed(8), cash: received.toFixed(8), fee: fee.toFixed(8), nextCash: q(cash.minus(gross)).toFixed(8), nextTokens: q(tokens.plus(quantity)).toFixed(8) };
}
export function cashForQuantity(poolCash, poolTokens, amount) {
  const cash = D(poolCash), tokens = D(poolTokens), quantity = D(amount);
  if (!quantity.gt(0) || !quantity.lt(tokens)) throw Error('Некорректное количество');
  const net = cash.mul(quantity).div(tokens.minus(quantity));
  return q(net.div('0.999').toDecimalPlaces(8, Decimal.ROUND_UP)).toFixed(8);
}
