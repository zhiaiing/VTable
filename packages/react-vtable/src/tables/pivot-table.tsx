import type React from 'react';
import type { PivotTableConstructorOptions } from 'k-vtable';
import { PivotTable as PivotTableConstrouctor } from 'k-vtable';
import type { BaseTableProps } from './base-table';
import { createTable } from './base-table';

export interface PivotTableProps
  extends Omit<BaseTableProps, 'records' | 'columnWidthConfig' | 'columns' | 'dragOrder' | 'resize'>,
    Omit<PivotTableConstructorOptions, 'container'> {}

export const PivotTable = createTable<React.PropsWithChildren<PivotTableProps>>('PivotTable', {
  type: 'pivot-table',
  vtableConstrouctor: PivotTableConstrouctor as any
});
