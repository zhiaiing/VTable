import type { ReactElement, JSXElementConstructor } from 'react';
import type { CheckboxAttributes, CheckBox as VCheakbox } from 'k-vtable/es/vrender';
import type { GraphicProps } from './type';

// component from vrender-component
export const Checkbox: (
  props: GraphicProps<CheckboxAttributes, VCheakbox>
) => ReactElement<
  GraphicProps<CheckboxAttributes, VCheakbox>,
  JSXElementConstructor<GraphicProps<CheckboxAttributes, VCheakbox>>
> = 'checkbox' as any;
