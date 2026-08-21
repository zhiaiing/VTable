import * as VTable from '../../src';

const CONTAINER_ID = 'vTable';
const TOOLBAR_ID = 'issue5253Toolbar';

const createRecords = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Person ${index + 1}`,
    email: `person${index + 1}@example.com`,
    city: index % 2 === 0 ? 'Beijing' : 'Shanghai'
  }));

const removeToolbar = () => {
  document.getElementById(TOOLBAR_ID)?.remove();
};

export function createTable() {
  removeToolbar();

  const container = document.getElementById(CONTAINER_ID);
  if (!container) {
    throw new Error('Cannot find VTable container');
  }

  container.style.width = '1000px';
  container.style.height = '800px';

  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.style.cssText = [
    'display: flex',
    'align-items: center',
    'gap: 12px',
    'min-height: 36px',
    'font-size: 12px',
    'line-height: 18px'
  ].join(';');
  toolbar.innerHTML = `
    <strong>Issue #5253</strong>
    <span>6 records / frozenRowCount=4 / bottomFrozenRowCount=1</span>
    <button id="issue5253CheckButton">重新检查</button>
    <strong id="issue5253Status">CHECKING</strong>
    <span id="issue5253Metrics"></span>
  `;
  container.before(toolbar);

  const tableInstance = new VTable.ListTable(container, {
    records: createRecords(6),
    columns: [
      { field: 'id', title: 'ID', width: 160 },
      { field: 'name', title: 'Name', width: 280 },
      { field: 'email', title: 'Email', width: 420 },
      { field: 'city', title: 'City', width: 260 }
    ],
    frozenRowCount: 4,
    bottomFrozenRowCount: 1,
    widthMode: 'standard',
    theme: VTable.themes.DEFAULT.extends({
      scrollStyle: {
        visible: 'always',
        hoverOn: false
      }
    })
  });

  const check = () => {
    const contentHeight = tableInstance.getAllRowsHeight();
    const tableGroupHeight = tableInstance.scenegraph.tableGroup.attribute.height;
    const bottomFrozenHeight = tableInstance.getBottomFrozenRowsHeight();
    const bottomFrozenY = tableInstance.scenegraph.bottomFrozenGroup.attribute.y;
    const expectedBottomFrozenY = contentHeight - bottomFrozenHeight;
    const pass = tableGroupHeight === contentHeight && bottomFrozenY === expectedBottomFrozenY;

    const status = document.getElementById('issue5253Status');
    const metrics = document.getElementById('issue5253Metrics');
    if (status) {
      status.textContent = pass ? 'PASS' : 'FAIL';
      status.style.color = pass ? '#237804' : '#cf1322';
    }
    if (metrics) {
      metrics.textContent = [
        `contentHeight=${contentHeight}`,
        `tableGroupHeight=${tableGroupHeight}`,
        `bottomFrozenY=${bottomFrozenY}`,
        `expectedBottomFrozenY=${expectedBottomFrozenY}`
      ].join(' | ');
    }

    return {
      pass,
      contentHeight,
      tableGroupHeight,
      bottomFrozenY,
      expectedBottomFrozenY
    };
  };

  document.getElementById('issue5253CheckButton')?.addEventListener('click', check);
  requestAnimationFrame(check);

  const release = tableInstance.release.bind(tableInstance);
  tableInstance.release = () => {
    removeToolbar();
    release();
  };

  const demoWindow = window as unknown as {
    tableInstance?: VTable.ListTable;
    issue5253Check?: typeof check;
  };
  demoWindow.tableInstance = tableInstance;
  demoWindow.issue5253Check = check;
}
