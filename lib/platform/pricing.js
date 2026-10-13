'use strict';

/**
 * 计费规则。
 *
 * 用户定价（m00117）：「一台设备收一次费……费用我认为可以先定为 1 元/月，
 * 最多可以买 3 个月」。
 * 所以：金额 = 设备数 × 月数 × 单价(分)，设备数 >= 1，月数 ∈ [1, maxMonths]。
 */

const { badRequest } = require('./http.js');

function toPositiveInt(value, field) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) throw badRequest(`${field} 必须是正整数`);
  return n;
}

/**
 * 计算报价。返回分单位的金额，绝不返回浮点元。
 */
function quote(config, { deviceCount, months }) {
  const devices = toPositiveInt(deviceCount, '设备数量');
  const term = toPositiveInt(months, '购买月数');
  const { unitCents, maxMonths, maxDevices, currency } = config.pricing;
  if (term > maxMonths) throw badRequest(`购买月数不能超过 ${maxMonths} 个月`);
  if (devices > maxDevices) throw badRequest(`单次购买设备数不能超过 ${maxDevices} 台`);
  return {
    deviceCount: devices,
    months: term,
    unitCents,
    amountCents: devices * term * unitCents,
    currency,
  };
}

/** 价格表，给前端渲染选择器用。 */
function plans(config) {
  const { unitCents, maxMonths, maxDevices, currency } = config.pricing;
  return {
    unitCents,
    unitYuan: (unitCents / 100).toFixed(2),
    maxMonths,
    maxDevices,
    currency,
    months: Array.from({ length: maxMonths }, (_, index) => ({
      months: index + 1,
      amountCents: (index + 1) * unitCents,
      amountYuan: (((index + 1) * unitCents) / 100).toFixed(2),
    })),
  };
}

module.exports = { quote, plans, toPositiveInt };
