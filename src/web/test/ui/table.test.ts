/**
 * Tests for the createTable helper.
 */

import { describe, it, expect } from 'vitest';
import { createTable } from '@/ui/table';

interface Row {
  name: string;
  amount: number;
}

describe('createTable', () => {
  const rows: Row[] = [
    { name: 'Alpha', amount: 100 },
    { name: 'Beta', amount: 200 },
  ];

  it('renders a header row from columns', () => {
    const table = createTable<Row>({
      columns: [
        { header: 'Name', render: (r) => r.name },
        { header: 'Amount', render: (r) => String(r.amount) },
      ],
      rows,
    });

    expect(table.tagName).toBe('TABLE');
    const ths = table.querySelectorAll('thead th');
    expect(ths).toHaveLength(2);
    expect(ths[0].textContent).toBe('Name');
    expect(ths[1].textContent).toBe('Amount');
  });

  it('renders one tr per row with the right text', () => {
    const table = createTable<Row>({
      columns: [
        { header: 'Name', render: (r) => r.name },
        { header: 'Amount', render: (r) => String(r.amount) },
      ],
      rows,
    });

    const bodyRows = table.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[0].textContent).toContain('Alpha');
    expect(bodyRows[0].textContent).toContain('100');
    expect(bodyRows[1].textContent).toContain('Beta');
  });

  it('escapes strings to textContent (no raw HTML injection)', () => {
    const table = createTable<Row>({
      columns: [{ header: 'Name', render: (r) => r.name }],
      rows: [{ name: '<script>alert(1)</script>', amount: 0 }],
    });
    const td = table.querySelector('tbody td');
    expect(td?.querySelector('script')).toBeNull();
    expect(td?.textContent).toBe('<script>alert(1)</script>');
  });

  it('returns empty-state wrapper when no rows and emptyState provided', () => {
    const el = createTable<Row>({
      columns: [{ header: 'Name', render: (r) => r.name }],
      rows: [],
      emptyState: 'Nothing here',
    });
    expect(el.tagName).toBe('DIV');
    expect(el.textContent).toBe('Nothing here');
  });

  it('applies alignment styles to cells', () => {
    const table = createTable<Row>({
      columns: [
        { header: 'Name', render: (r) => r.name },
        { header: 'Amount', render: (r) => String(r.amount), align: 'right' },
      ],
      rows,
    });
    const cells = table.querySelectorAll('tbody tr:first-child td');
    expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
  });
});
