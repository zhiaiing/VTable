import { DefaultRenderService, type IGraphic, type IRenderService, type IStage } from '@src/vrender';
import type { BaseTableAPI } from '../../ts-types/base-table';
import { Group } from '../graphic/group';

/** Only specialize the default service; caller-owned renderers keep their prepare lifecycle. */
export function installTableRenderService(stage: IStage) {
  const service = stage.renderService;
  if (
    Object.getPrototypeOf(service) === DefaultRenderService.prototype &&
    service.prepare === DefaultRenderService.prototype.prepare
  ) {
    service.prepare = prepare;
  }
}

function prepare(this: IRenderService, updateBounds: boolean) {
  if (!updateBounds) {
    return;
  }
  this.renderTreeRoots.forEach(root => {
    const table = (root.stage as IStage & { table?: BaseTableAPI })?.table;
    const range = table?.getBodyVisibleCellRange();
    // Query row/column sizes once per root, rather than for every graphic.
    const visit = (graphic: IGraphic) => {
      if (
        range &&
        graphic instanceof Group &&
        graphic.role === 'cell' &&
        graphic.mergeStartCol === undefined &&
        graphic.attribute.clip !== false &&
        !graphic.shadowRoot &&
        ((graphic.row >= table.frozenRowCount &&
          graphic.row < table.rowCount - table.bottomFrozenRowCount &&
          (graphic.row < range.rowStart - 1 || graphic.row > range.rowEnd + 1)) ||
          (graphic.col >= table.frozenColCount &&
            graphic.col < table.colCount - table.rightFrozenColCount &&
            (graphic.col < range.colStart - 1 || graphic.col > range.colEnd + 1)))
      ) {
        // Keep dirty tags so the subtree updates when it next enters the viewport.
        return;
      }
      graphic.forEachChildren(child => visit(child as IGraphic));
      graphic.update({ bounds: updateBounds, trans: true });
    };
    visit(root);
  });
}
