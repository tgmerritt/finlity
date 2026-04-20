/**
 * Typed table factory that replaces hand-rolled createElement('tr') loops
 * throughout the pages. Columns describe how to render a cell for each
 * row; pass either a plain string (rendered as text) or a Node when HTML
 * nesting is required.
 *
 * Callers that need pre-formatted HTML should build a DocumentFragment or
 * escape with utils/html#escapeHtml first — this helper does not inject
 * raw HTML strings to avoid XSS.
 */

export interface TableColumn<T> {
  /** Header label. */
  header: string;
  /** Cell renderer; return a string (rendered as text) or a Node. */
  render: (row: T, index: number) => string | Node;
  /** Optional className applied to the <td>. */
  className?: string;
  /** Optional className applied to the <th>. */
  headerClassName?: string;
  /** Aligns the column when set to 'right' | 'center'. Defaults to left. */
  align?: 'left' | 'right' | 'center';
}

export interface CreateTableOptions<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  /** Applied to the outer <table>. */
  className?: string;
  /** Rendered when `rows` is empty. String rendered as text, Node rendered as-is. */
  emptyState?: string | Node;
  /** Callback for optional per-row class. */
  rowClassName?: (row: T, index: number) => string | undefined;
}

function appendContent(cell: HTMLElement, content: string | Node): void {
  if (typeof content === 'string') {
    cell.textContent = content;
  } else {
    cell.appendChild(content);
  }
}

export function createTable<T>(options: CreateTableOptions<T>): HTMLTableElement | HTMLDivElement {
  const { columns, rows, className, emptyState, rowClassName } = options;

  if (rows.length === 0 && emptyState !== undefined) {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-empty';
    appendContent(wrapper, emptyState);
    return wrapper;
  }

  const table = document.createElement('table');
  if (className) table.className = className;

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col.header;
    if (col.headerClassName) th.className = col.headerClassName;
    if (col.align) th.style.textAlign = col.align;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const rowClass = rowClassName?.(row, index);
    if (rowClass) tr.className = rowClass;

    for (const col of columns) {
      const td = document.createElement('td');
      if (col.className) td.className = col.className;
      if (col.align) td.style.textAlign = col.align;
      appendContent(td, col.render(row, index));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  return table;
}
