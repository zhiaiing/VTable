import type { IGraphic } from './../../vrender';
import type { BaseTableAPI } from '../../ts-types/base-table';
import { Group } from '../graphic/group';

/** Cache the nine frozen/body clip regions once for each draw context. */
export function getCellClipBounds(table?: BaseTableAPI) {
  const width = table?.scenegraph.width ?? table?.tableNoFrameWidth;
  const height = table?.scenegraph.height ?? table?.tableNoFrameHeight;
  return table
    ? {
        table,
        width,
        height,
        left: table.getFrozenColsWidth(),
        right: width - table.getRightFrozenColsWidth(),
        top: table.getFrozenRowsHeight(),
        bottom: height - table.getBottomFrozenRowsHeight()
      }
    : undefined;
}

export function isCellOutsideClip(graphic: IGraphic, bounds: ReturnType<typeof getCellClipBounds>): boolean {
  if (
    !bounds ||
    !(graphic instanceof Group) ||
    graphic.role !== 'cell' ||
    graphic.mergeStartCol !== undefined ||
    graphic.attribute.clip === false ||
    graphic.shadowRoot
  ) {
    return false;
  }
  const column = graphic.parent as Group;
  const region = column?.parent as Group;
  const { table } = bounds;
  if (region?.parent !== table.scenegraph.tableGroup) {
    return false;
  }
  // Custom transforms need the regular bounds path; the fast path is translation-only.
  if (
    [graphic, column, region].some(
      node =>
        (node.attribute.scaleX ?? 1) !== 1 ||
        (node.attribute.scaleY ?? 1) !== 1 ||
        !!node.attribute.angle ||
        !!node.attribute.postMatrix
    )
  ) {
    return false;
  }
  // Work in table-local coordinates. Reading global bounds here would recursively
  // update transforms for the very custom subtrees we are about to discard.
  const x =
    (graphic.attribute.x ?? 0) +
    (column.attribute.x ?? 0) +
    (region.attribute.x ?? 0) +
    (graphic.attribute.dx ?? 0) +
    (column.attribute.dx ?? 0) +
    (region.attribute.dx ?? 0);
  const y =
    (graphic.attribute.y ?? 0) +
    (column.attribute.y ?? 0) +
    (region.attribute.y ?? 0) +
    (graphic.attribute.dy ?? 0) +
    (column.attribute.dy ?? 0) +
    (region.attribute.dy ?? 0);
  const leftFrozen = graphic.col < table.frozenColCount;
  const rightFrozen = graphic.col >= table.colCount - table.rightFrozenColCount;
  const topFrozen = graphic.row < table.frozenRowCount;
  const bottomFrozen = graphic.row >= table.rowCount - table.bottomFrozenRowCount;
  const left = leftFrozen ? 0 : rightFrozen ? bounds.right : bounds.left;
  const right = leftFrozen ? bounds.left : rightFrozen ? bounds.width : bounds.right;
  const top = topFrozen ? 0 : bottomFrozen ? bounds.bottom : bounds.top;
  const bottom = topFrozen ? bounds.top : bottomFrozen ? bounds.height : bounds.bottom;
  // Keep boundary strokes and cells crossing a frozen edge.
  const margin = Math.max(1, (graphic.attribute.lineWidth ?? 1) / 2);
  return (
    x + graphic.attribute.width < left - margin ||
    x > right + margin ||
    y + graphic.attribute.height < top - margin ||
    y > bottom + margin
  );
}
