import type { BaseComponentProps } from '../base-component';
import { createComponent } from '../base-component';
import type { ICornerDefine } from 'k-vtable';

export type PivotCornerProps = ICornerDefine & BaseComponentProps;

export const PivotCorner = createComponent<PivotCornerProps>('PivotCorner', 'corner', undefined, true);
