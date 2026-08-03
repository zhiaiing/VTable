import { isArray, isString } from '@visactor/vutils';
import type { BaseTableAPI, GroupByOption } from '../ts-types';

export function getGroupByDataConfig(
  groupByOption: GroupByOption,
  addRecordRule: 'Array' | 'Object',
  customDealGroupData?: (records: any[]) => any[]
) {
  // no sort temply
  if (isString(groupByOption)) {
    return { groupByRules: [groupByOption], addRecordRule, customDealGroupData };
  }
  if (isArray(groupByOption)) {
    const groupByRules = groupByOption.map(item => {
      if (isString(item)) {
        return item;
      }
      return item.key;
    });
    return { groupByRules, addRecordRule, customDealGroupData };
  }

  return { addRecordRule, customDealGroupData };
}
