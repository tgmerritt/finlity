/**
 * AI Commentary System
 * Provides AI-generated insights for dashboard elements with streaming support.
 */

import { showToast } from '@/ui/toast';
import { getBaseUrl } from '@/api/client';

/**
 * Commentary data from API.
 */
export interface CommentaryData {
  commentary: string;
  age_hours?: number;
  is_cached?: boolean;
  is_static?: boolean;
  element_id: string;
  action_items?: string[];
  error?: string;
}

/**
 * Static explanation configuration.
 */
interface StaticExplanation {
  title: string;
  content: string;
  is_static: true;
}

/**
 * SSE message types for streaming commentary.
 */
interface CommentarySSEMessage {
  type?: 'cached' | 'chunk' | 'complete';
  error?: string;
  commentary?: string;
  text?: string;
  age_hours?: number;
}

/**
 * Static explanations for elements that don't need dynamic AI generation.
 * These are pre-written, educational explanations that apply universally.
 */
const STATIC_EXPLANATIONS: Record<string, StaticExplanation> = {
  'projections.monte_carlo_settings': {
    title: 'What is a Monte Carlo Simulation?',
    content: `**Monte Carlo simulation** is a way to understand how your retirement savings might grow over time, accounting for the uncertainty of the stock market.

**How it works:**

Instead of assuming the market returns exactly 7% every year (which never happens in real life), Monte Carlo runs **thousands of simulated futures**. Each simulation uses random market returns based on historical patterns—some years up 20%, others down 15%, just like reality.

**What the results tell you:**

- **Success Rate**: The percentage of simulations where you didn't run out of money. 80-90% is generally considered good.
- **Percentile Bands**: The shaded areas show the range of possible outcomes. The median (50th percentile) is the "typical" case, while the 10th and 90th percentiles show pessimistic and optimistic scenarios.

**The settings explained:**

- **Current/Retirement Age**: Your timeline for saving vs. spending
- **Monthly Contribution**: What you're adding during working years
- **Monthly Withdrawal**: What you'll spend in retirement
- **Stocks/Bonds %**: Higher stocks = more growth potential but more volatility

**Key insight**: Monte Carlo doesn't predict the future—it shows the *range of possibilities* so you can plan for uncertainty rather than a single "best guess."`,
    is_static: true,
  },
};

/**
 * Cache for commentary responses.
 */
let commentaryCache: Record<string, CommentaryData> = {};

/**
 * Currently active popover element.
 */
let activePopover: HTMLElement | null = null;

/**
 * Track if event listeners have been initialized.
 */
let commentaryListenersInitialized = false;

/**
 * Clear the AI commentary cache.
 * Call this when switching databases/profiles.
 */
export function clearCommentaryCache(): void {
  commentaryCache = {};
  // Remove any existing AI buttons so they can be re-initialized
  document.querySelectorAll('.ai-info-btn').forEach((btn) => btn.remove());
  // Close any open popovers
  closeAICommentary();
  console.debug('AI Commentary: Cache and buttons cleared');
}

/**
 * Extract visible data from the page for a given element.
 * This allows the AI to "see" the current values displayed on the page.
 */
function extractVisibleData(elementId: string): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};

  // Handle tax projection tiles
  if (elementId.startsWith('taxes.')) {
    // Extract all tax tile values
    const federalEl = document.getElementById('tax-total-federal');
    const stateEl = document.getElementById('tax-total-state');
    const totalEl = document.getElementById('tax-total-all');
    const avgRateEl = document.getElementById('tax-avg-rate');
    const withdrawnEl = document.getElementById('tax-total-withdrawn');
    const balanceEl = document.getElementById('tax-final-balance');
    const federalDetailEl = document.getElementById('tax-federal-detail');
    const stateDetailEl = document.getElementById('tax-state-detail');
    const totalDetailEl = document.getElementById('tax-total-detail');
    const withdrawnDetailEl = document.getElementById('tax-withdrawn-detail');
    const balanceDetailEl = document.getElementById('tax-balance-detail');
    const contextPeriodEl = document.getElementById('tax-context-period');
    const contextYearsEl = document.getElementById('tax-context-years');

    // Get tax projection settings from form inputs
    const currentAgeEl = document.getElementById('tax-current-age') as HTMLInputElement;
    const retireAgeEl = document.getElementById('tax-retirement-age') as HTMLInputElement;
    const endAgeEl = document.getElementById('tax-end-age') as HTMLInputElement;
    const annualSpendEl = document.getElementById('tax-annual-spending') as HTMLInputElement;
    const federalRateEl = document.getElementById('tax-federal-rate') as HTMLInputElement;
    const stateRateEl = document.getElementById('tax-state-rate') as HTMLInputElement;

    data.federal_tax_total = federalEl?.textContent || 'Not calculated';
    data.state_tax_total = stateEl?.textContent || 'Not calculated';
    data.total_lifetime_tax = totalEl?.textContent || 'Not calculated';
    data.average_effective_rate = avgRateEl?.textContent || 'Not calculated';
    data.total_withdrawn = withdrawnEl?.textContent || 'Not calculated';
    data.final_balance = balanceEl?.textContent || 'Not calculated';
    data.federal_detail = federalDetailEl?.textContent || '';
    data.state_detail = stateDetailEl?.textContent || '';
    data.total_detail = totalDetailEl?.textContent || '';
    data.withdrawn_detail = withdrawnDetailEl?.textContent || '';
    data.balance_detail = balanceDetailEl?.textContent || '';
    data.projection_period = contextPeriodEl?.textContent || '';
    data.projection_years = contextYearsEl?.textContent || '';

    // Settings
    data.current_age = currentAgeEl?.value || '';
    data.retirement_age = retireAgeEl?.value || '';
    data.end_age = endAgeEl?.value || '';
    data.annual_spending = annualSpendEl?.value || '';
    data.federal_rate = federalRateEl?.value || '';
    data.state_rate = stateRateEl?.value || '';

    // Add which specific tile was clicked
    data.clicked_tile = elementId;

    return data;
  }

  // Handle dashboard chart tiles (allocation and account type)
  if (elementId === 'dashboard.allocation_chart') {
    // Extract allocation data from Plotly chart
    const chartDiv = document.getElementById('chart-allocation') as HTMLElement & { data?: unknown[] };
    if (!chartDiv) {
      console.warn('AI Commentary: chart-allocation element not found');
      data.extraction_error = 'Chart element not found';
      return data;
    }
    if (!chartDiv.data || !chartDiv.data[0]) {
      console.warn('AI Commentary: allocation chart has no data (chart may not be rendered yet)');
      data.extraction_error = 'Chart data not available';
      return data;
    }
    const chartData = chartDiv.data[0] as { labels?: string[]; values?: number[] };
    const labels = chartData.labels;
    const values = chartData.values;
    if (!labels || !values) {
      console.warn('AI Commentary: allocation chart missing labels or values');
      data.extraction_error = 'Chart data incomplete';
      return data;
    }
    const total = values.reduce((sum: number, v: number) => sum + v, 0);
    if (total <= 0) {
      console.warn('AI Commentary: allocation chart total is zero or negative');
      data.extraction_error = 'No allocation data';
      return data;
    }
    const allocations: string[] = [];
    // Limit to top 10 allocations to keep prompt size manageable
    for (let i = 0; i < Math.min(labels.length, 10); i++) {
      const val = values[i];
      if (val === undefined) {
        console.warn(`AI Commentary: allocation data missing at index ${i}`);
        continue;
      }
      const pct = (val / total * 100).toFixed(1);
      allocations.push(`${labels[i]}: ${pct}%`);
    }
    data.allocation_summary = allocations.join(', ');
    data.num_positions = labels.length;
    // Calculate top 5 and top 10 concentration percentages
    const sortedValues = [...values].sort((a, b) => b - a);
    const top5Value = sortedValues.slice(0, 5).reduce((sum, v) => sum + v, 0);
    const top10Value = sortedValues.slice(0, 10).reduce((sum, v) => sum + v, 0);
    data.top_5_pct = (top5Value / total * 100);
    data.top_10_pct = (top10Value / total * 100);
    return data;
  }

  if (elementId === 'dashboard.account_type_chart') {
    // Extract account type data from Plotly chart
    const chartDiv = document.getElementById('chart-account-type') as HTMLElement & { data?: unknown[] };
    if (!chartDiv) {
      console.warn('AI Commentary: chart-account-type element not found');
      data.extraction_error = 'Chart element not found';
      return data;
    }
    if (!chartDiv.data || !chartDiv.data[0]) {
      console.warn('AI Commentary: account type chart has no data (chart may not be rendered yet)');
      data.extraction_error = 'Chart data not available';
      return data;
    }
    const chartData = chartDiv.data[0] as { labels?: string[]; values?: number[] };
    const labels = chartData.labels;
    const values = chartData.values;
    if (!labels || !values) {
      console.warn('AI Commentary: account type chart missing labels or values');
      data.extraction_error = 'Chart data incomplete';
      return data;
    }
    const total = values.reduce((sum: number, v: number) => sum + v, 0);
    if (total <= 0) {
      console.warn('AI Commentary: account type chart total is zero or negative');
      data.extraction_error = 'No account data';
      return data;
    }
    const allocations: string[] = [];
    let taxableValue = 0;
    let traditionalValue = 0;
    let rothValue = 0;
    let taxAdvantagedValue = 0;
    let otherValue = 0;

    for (let i = 0; i < labels.length; i++) {
      const labelText = labels[i];
      const value = values[i];
      if (labelText === undefined || value === undefined) {
        console.warn(`AI Commentary: account type data missing at index ${i}`);
        continue;
      }

      const label = labelText.toLowerCase();
      const pct = (value / total * 100).toFixed(1);
      allocations.push(`${labelText}: ${pct}%`);

      // Categorize by account type for tax analysis
      // Priority: specific matches first, then general categories
      if (label.includes('taxable') || label === 'brokerage') {
        taxableValue += value;
      } else if (label.includes('traditional') || (label.includes('401k') && !label.includes('roth'))) {
        traditionalValue += value;
        taxAdvantagedValue += value;
      } else if (label.includes('roth')) {
        rothValue += value;
        taxAdvantagedValue += value;
      } else if (label.includes('529') || label.includes('education')) {
        // 529 plans are tax-advantaged but neither traditional nor Roth
        taxAdvantagedValue += value;
      } else if (label.includes('ira') || label.includes('retirement')) {
        // Generic IRA/retirement accounts default to traditional
        traditionalValue += value;
        taxAdvantagedValue += value;
      } else if (label.includes('hsa') || label.includes('health')) {
        // HSA is tax-advantaged (triple tax benefit)
        taxAdvantagedValue += value;
      } else if (label.includes('property') || label.includes('real estate')) {
        // Real estate is typically in taxable category
        taxableValue += value;
      } else {
        // Track uncategorized accounts so percentages still add up
        otherValue += value;
        console.warn(`AI Commentary: uncategorized account type "${labelText}" with value ${value}`);
      }
    }

    data.account_type_summary = allocations.join(', ');
    data.taxable_pct = (taxableValue / total * 100);
    data.traditional_pct = (traditionalValue / total * 100);
    data.roth_pct = (rothValue / total * 100);
    data.tax_advantaged_pct = (taxAdvantagedValue / total * 100);
    if (otherValue > 0) {
      data.other_pct = (otherValue / total * 100);
      data.has_uncategorized = true;
    }
    return data;
  }

  // Handle dashboard stat tiles
  if (elementId.startsWith('dashboard.')) {
    // Get the stat card containing this button
    const cardId = elementId.replace('dashboard.', '');
    const statCard = document.querySelector(`[data-stat="${cardId}"]`) ||
                     document.querySelector(`.stat-card:has([data-element-id="${elementId}"])`);

    if (statCard) {
      const value = statCard.querySelector('.stat-value, .stat-card-value');
      const label = statCard.querySelector('.stat-label, .stat-card-label');
      data.value = value?.textContent || '';
      data.label = label?.textContent || '';
    }
    return data;
  }

  return null;
}

/**
 * Parsed markdown token types.
 */
type MarkdownToken =
  | { type: 'paragraph'; content: InlineToken[] }
  | { type: 'bullet-list'; items: InlineToken[][] }
  | { type: 'numbered-list'; items: InlineToken[][] };

type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'bold'; content: string }
  | { type: 'italic'; content: string };

/**
 * Parse inline markdown (bold, italic) into tokens.
 */
function parseInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Check for bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch && boldMatch[2]) {
      tokens.push({ type: 'bold', content: boldMatch[2] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Check for italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)([^*_]+?)\1/);
    if (italicMatch && italicMatch[2]) {
      tokens.push({ type: 'italic', content: italicMatch[2] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Find next special character
    const nextSpecial = remaining.search(/[*_]/);
    if (nextSpecial === -1) {
      // No more special characters
      tokens.push({ type: 'text', content: remaining });
      break;
    } else if (nextSpecial === 0) {
      // Special character at start but didn't match pattern - treat as text
      tokens.push({ type: 'text', content: remaining.charAt(0) });
      remaining = remaining.slice(1);
    } else {
      // Text before special character
      tokens.push({ type: 'text', content: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    }
  }

  return tokens;
}

/**
 * Parse markdown text into tokens for safe DOM rendering.
 */
function parseMarkdownToTokens(text: string): MarkdownToken[] {
  if (!text) return [];

  const lines = text.split('\n');
  const tokens: MarkdownToken[] = [];
  let currentBulletItems: InlineToken[][] = [];
  let currentNumberedItems: InlineToken[][] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Bullet list: - item or * item
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      // Flush numbered list if any
      if (currentNumberedItems.length > 0) {
        tokens.push({ type: 'numbered-list', items: currentNumberedItems });
        currentNumberedItems = [];
      }
      currentBulletItems.push(parseInlineMarkdown(bulletMatch[1] || ''));
      continue;
    }

    // Numbered list: 1. item
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      // Flush bullet list if any
      if (currentBulletItems.length > 0) {
        tokens.push({ type: 'bullet-list', items: currentBulletItems });
        currentBulletItems = [];
      }
      currentNumberedItems.push(parseInlineMarkdown(numberedMatch[1] || ''));
      continue;
    }

    // End lists if we hit a non-list line
    if (currentBulletItems.length > 0) {
      tokens.push({ type: 'bullet-list', items: currentBulletItems });
      currentBulletItems = [];
    }
    if (currentNumberedItems.length > 0) {
      tokens.push({ type: 'numbered-list', items: currentNumberedItems });
      currentNumberedItems = [];
    }

    // Regular line - wrap in paragraph if not empty
    if (line) {
      tokens.push({ type: 'paragraph', content: parseInlineMarkdown(line) });
    }
  }

  // Flush any remaining lists
  if (currentBulletItems.length > 0) {
    tokens.push({ type: 'bullet-list', items: currentBulletItems });
  }
  if (currentNumberedItems.length > 0) {
    tokens.push({ type: 'numbered-list', items: currentNumberedItems });
  }

  return tokens;
}

/**
 * Render inline tokens to a container element.
 */
function renderInlineTokens(container: HTMLElement, tokens: InlineToken[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        container.appendChild(document.createTextNode(token.content));
        break;
      case 'bold': {
        const strong = document.createElement('strong');
        strong.textContent = token.content;
        container.appendChild(strong);
        break;
      }
      case 'italic': {
        const em = document.createElement('em');
        em.textContent = token.content;
        container.appendChild(em);
        break;
      }
    }
  }
}

/**
 * Render parsed markdown tokens to a container using safe DOM methods.
 */
function renderMarkdownToElement(container: HTMLElement, text: string): void {
  container.textContent = ''; // Clear existing content

  const tokens = parseMarkdownToTokens(text);

  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph': {
        const p = document.createElement('p');
        renderInlineTokens(p, token.content);
        container.appendChild(p);
        break;
      }
      case 'bullet-list': {
        const ul = document.createElement('ul');
        for (const itemTokens of token.items) {
          const li = document.createElement('li');
          renderInlineTokens(li, itemTokens);
          ul.appendChild(li);
        }
        container.appendChild(ul);
        break;
      }
      case 'numbered-list': {
        const ol = document.createElement('ol');
        for (const itemTokens of token.items) {
          const li = document.createElement('li');
          renderInlineTokens(li, itemTokens);
          ol.appendChild(li);
        }
        container.appendChild(ol);
        break;
      }
    }
  }

  // If no content was rendered, show default message
  if (container.childNodes.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No commentary available.';
    container.appendChild(p);
  }
}

/**
 * Create popover element for commentary display.
 */
function createPopoverElement(elementId: string): HTMLDivElement {
  const popover = document.createElement('div');
  popover.className = 'ai-commentary-popover';
  popover.id = 'ai-popover-' + elementId.replace(/\./g, '-');

  const header = document.createElement('div');
  header.className = 'commentary-header';

  const badge = document.createElement('span');
  badge.className = 'ai-badge';
  badge.textContent = 'AI Insight';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'commentary-close';
  closeBtn.textContent = '×';
  closeBtn.onclick = closeAICommentary;

  header.appendChild(badge);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'commentary-body';

  const loading = document.createElement('div');
  loading.className = 'commentary-loading';

  const spinner = document.createElement('div');
  spinner.className = 'commentary-loading-spinner';

  const loadingText = document.createElement('span');
  loadingText.className = 'commentary-loading-text';
  loadingText.textContent = 'Generating insight...';

  loading.appendChild(spinner);
  loading.appendChild(loadingText);
  body.appendChild(loading);

  popover.appendChild(header);
  popover.appendChild(body);

  return popover;
}

/**
 * Show AI commentary popover for an element.
 */
export async function showAICommentary(button: HTMLButtonElement): Promise<void> {
  const elementId = button.dataset.elementId;
  if (!elementId) return;

  // Close any existing popover
  closeAICommentary();

  // Create container and popover
  const container = document.createElement('div');
  container.className = 'ai-popover-container';

  const popover = createPopoverElement(elementId);
  container.appendChild(popover);
  document.body.appendChild(container);
  activePopover = container;

  // Position the popover (use fixed positioning)
  positionPopover(popover, button);

  // Trigger animation by adding visible class after append
  requestAnimationFrame(() => {
    container.classList.add('visible');
  });

  // Check for static explanation first (no API call needed)
  if (STATIC_EXPLANATIONS[elementId]) {
    const staticData = STATIC_EXPLANATIONS[elementId];
    renderCommentaryContent(popover, {
      commentary: staticData.content,
      is_static: true,
      element_id: elementId,
    });
    return;
  }

  // Check cache for dynamic content
  if (commentaryCache[elementId] && !commentaryCache[elementId].error) {
    renderCommentaryContent(popover, commentaryCache[elementId]);
    return;
  }

  // Use streaming API for real-time text generation
  try {
    const baseUrl = getBaseUrl();

    // Extract visible data from the page to send to the AI
    const visibleData = extractVisibleData(elementId);
    let streamUrl = `${baseUrl}/api/commentary/${elementId}/stream`;
    if (visibleData) {
      const dataParam = encodeURIComponent(JSON.stringify(visibleData));
      streamUrl += `?data=${dataParam}`;
    }

    const eventSource = new EventSource(streamUrl);
    let fullText = '';
    let ageHours = 0;

    // Get content area and prepare for streaming
    const body = popover.querySelector('.commentary-body');
    const loading = body?.querySelector('.commentary-loading');

    eventSource.onmessage = (event: MessageEvent) => {
      let data: CommentarySSEMessage;
      try {
        data = JSON.parse(event.data);
      } catch (parseError) {
        console.error('Failed to parse SSE message:', parseError, event.data);
        eventSource.close();
        renderCommentaryError(popover, 'Failed to parse server response');
        return;
      }

      if (data.error) {
        eventSource.close();
        renderCommentaryError(popover, data.error);
        return;
      }

      if (data.type === 'cached') {
        // Cached response - show immediately
        fullText = data.commentary || '';
        ageHours = data.age_hours || 0;
        eventSource.close();
        commentaryCache[elementId] = {
          commentary: fullText,
          age_hours: ageHours,
          is_cached: true,
          element_id: elementId,
        };
        renderCommentaryContent(popover, commentaryCache[elementId]);
        return;
      }

      if (data.type === 'chunk') {
        // First chunk - switch from loading to content
        if (!fullText && body) {
          if (loading) loading.remove();
          const contentDiv = document.createElement('div');
          contentDiv.className = 'commentary-content streaming';
          body.appendChild(contentDiv);
        }

        fullText += data.text || '';

        // Update content with parsed markdown using safe DOM methods
        const contentDiv = body?.querySelector('.commentary-content');
        if (contentDiv instanceof HTMLElement) {
          renderMarkdownToElement(contentDiv, fullText);
        }
      }

      if (data.type === 'complete' && body) {
        eventSource.close();
        ageHours = data.age_hours || 0;

        // Cache the result
        commentaryCache[elementId] = {
          commentary: fullText,
          age_hours: ageHours,
          is_cached: false,
          element_id: elementId,
        };

        // Remove streaming class
        const contentDiv = body.querySelector('.commentary-content');
        if (contentDiv) {
          contentDiv.classList.remove('streaming');
        }

        // Add footer
        const footer = document.createElement('div');
        footer.className = 'commentary-footer';

        const ageSpan = document.createElement('span');
        ageSpan.className = 'commentary-age';
        ageSpan.textContent = 'Generated just now';
        footer.appendChild(ageSpan);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'btn btn-sm btn-link';
        refreshBtn.textContent = 'Refresh';
        refreshBtn.onclick = () => refreshCommentary(elementId);
        footer.appendChild(refreshBtn);

        body.appendChild(footer);
      }
    };

    eventSource.onerror = (error: Event) => {
      console.error('SSE error:', error);
      eventSource.close();
      if (!fullText) {
        renderCommentaryError(popover, 'Connection error. Please try again.');
      }
    };
  } catch (error) {
    console.error('Failed to start streaming:', error);
    renderCommentaryError(popover, error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Close the active AI commentary popover.
 */
export function closeAICommentary(): void {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  // Also close any orphaned containers and popovers
  document.querySelectorAll('.ai-popover-container').forEach((c) => c.remove());
  document.querySelectorAll('.ai-commentary-popover').forEach((p) => p.remove());
}

/**
 * Position popover relative to button.
 */
function positionPopover(popover: HTMLElement, button: HTMLElement): void {
  const rect = button.getBoundingClientRect();

  // Default position: below and to the right
  let top = rect.bottom + 8;
  let left = rect.left;

  // Adjust if would go off right edge
  if (left + 350 > window.innerWidth) {
    left = window.innerWidth - 360;
  }

  // Adjust if would go off bottom edge
  if (top + 300 > window.innerHeight) {
    top = rect.top - 308;
  }

  // Ensure doesn't go off left edge
  if (left < 10) {
    left = 10;
  }

  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
}

/**
 * Get formatted age text from hours.
 */
function getAgeText(ageHours: number | undefined): string {
  if (ageHours === undefined) return '';

  if (ageHours < 1) {
    return 'Generated just now';
  } else if (ageHours < 24) {
    return `Generated ${Math.round(ageHours)} hours ago`;
  } else {
    return `Generated ${Math.round(ageHours / 24)} days ago`;
  }
}

/**
 * Render commentary content in popover.
 */
function renderCommentaryContent(popover: HTMLElement, data: CommentaryData): void {
  const body = popover.querySelector('.commentary-body');
  if (!body) return;

  body.textContent = ''; // Clear loading

  const ageText = getAgeText(data.age_hours);

  // Content div - render markdown using safe DOM methods
  const contentDiv = document.createElement('div');
  contentDiv.className = 'commentary-content';
  renderMarkdownToElement(contentDiv, data.commentary);
  body.appendChild(contentDiv);

  // Action items (if any)
  if (data.action_items && data.action_items.length > 0) {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'commentary-actions';

    const actionsTitle = document.createElement('strong');
    actionsTitle.textContent = 'Suggested Actions:';
    actionsDiv.appendChild(actionsTitle);

    const actionsList = document.createElement('ul');
    data.action_items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      actionsList.appendChild(li);
    });
    actionsDiv.appendChild(actionsList);
    body.appendChild(actionsDiv);
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'commentary-footer';

  const ageSpan = document.createElement('span');
  ageSpan.className = 'commentary-age';

  if (data.is_static) {
    // Static explanation - no refresh needed
    ageSpan.textContent = 'Educational content';
  } else {
    // Dynamic AI-generated content
    ageSpan.textContent = ageText + (data.is_cached ? ' (cached)' : '');

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-sm btn-link';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = () => refreshCommentary(data.element_id);
    footer.appendChild(refreshBtn);
  }

  footer.insertBefore(ageSpan, footer.firstChild);
  body.appendChild(footer);
}

/**
 * Render error state in popover.
 */
function renderCommentaryError(popover: HTMLElement, message: string): void {
  const body = popover.querySelector('.commentary-body');
  if (!body) return;

  body.textContent = ''; // Clear loading

  const errorDiv = document.createElement('div');
  errorDiv.className = 'commentary-error';

  const errorIcon = document.createElement('span');
  errorIcon.className = 'error-icon';
  errorIcon.textContent = '⚠️';

  const errorText = document.createElement('span');
  errorText.textContent = 'Unable to generate insight';

  const errorDetail = document.createElement('small');
  errorDetail.textContent = message;

  errorDiv.appendChild(errorIcon);
  errorDiv.appendChild(errorText);
  errorDiv.appendChild(errorDetail);
  body.appendChild(errorDiv);
}

/**
 * Refresh a single commentary element.
 */
export async function refreshCommentary(elementId: string): Promise<void> {
  // Clear from cache
  delete commentaryCache[elementId];

  // Find the button and re-trigger
  const button = document.querySelector(`[data-element-id="${elementId}"]`);
  if (button instanceof HTMLButtonElement) {
    // Close current popover
    closeAICommentary();

    // Re-fetch with force refresh
    try {
      const baseUrl = getBaseUrl();
      const response = await fetch(`${baseUrl}/api/commentary/${elementId}?force_refresh=true`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      commentaryCache[elementId] = data;

      // Re-show the popover
      await showAICommentary(button);
    } catch (error) {
      console.error('Failed to refresh commentary:', error);
      showToast('Failed to refresh insight', 'error');
    }
  }
}

/**
 * Refresh all AI insights.
 */
export async function refreshAllAIInsights(): Promise<void> {
  try {
    showToast('Refreshing AI insights...', 'info');
    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/api/commentary/refresh`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();
    commentaryCache = {};
    showToast(`Refreshed ${result.refreshed_count} insights`, 'success');
  } catch (error) {
    console.error('Failed to refresh all insights:', error);
    showToast('Failed to refresh insights', 'error');
  }
}

/**
 * Create an AI info button for an element.
 */
function createInfoButton(elementId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ai-info-btn';
  btn.dataset.elementId = elementId;
  btn.title = 'Get AI insight';
  btn.textContent = '?';
  btn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    showAICommentary(btn);
  });

  return btn;
}

/**
 * Initialize AI commentary buttons on dashboard.
 */
export function initAICommentaryButtons(): void {
  // Map value element IDs to commentary element IDs
  const elementMappings: Record<string, string> = {
    'total-value': 'dashboard.total_value',
    'gain-loss': 'dashboard.total_gain_loss',
    'retirement-value': 'dashboard.retirement_value',
    'taxable-value': 'dashboard.taxable_value',
    'monthly-retirement-income': 'dashboard.monthly_retirement_income',
    'success-probability': 'dashboard.success_probability',
  };

  let buttonsAdded = 0;

  // Find stat cards by the value element IDs they contain
  Object.entries(elementMappings).forEach(([valueId, commentaryId]) => {
    const valueElement = document.getElementById(valueId);
    if (!valueElement) {
      console.debug(`AI Commentary: Element '${valueId}' not found`);
      return;
    }

    // Find the parent stat-card
    const card = valueElement.closest('.stat-card');
    if (!card) {
      console.debug(`AI Commentary: stat-card not found for '${valueId}'`);
      return;
    }

    // Check if button already exists
    if (card.querySelector('.ai-info-btn')) {
      return;
    }

    const label = card.querySelector('.stat-label');
    if (label) {
      const btn = createInfoButton(commentaryId);
      label.appendChild(btn);
      buttonsAdded++;
    }
  });

  if (buttonsAdded > 0) {
    console.debug(`AI Commentary: Added ${buttonsAdded} insight buttons`);
  }

  // Only add event listeners once
  if (!commentaryListenersInitialized) {
    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (activePopover && !activePopover.contains(target) && !target.closest('.ai-info-btn')) {
        closeAICommentary();
      }
    });

    // Close popover on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAICommentary();
      }
    });

    commentaryListenersInitialized = true;
  }
}

/**
 * Get commentary from cache.
 */
export function getCommentaryCache(): Record<string, CommentaryData> {
  return commentaryCache;
}

/**
 * Initialize the commentary system.
 */
export function initCommentary(): void {
  // Commentary buttons are added after data loads in dashboard
  // This function can be used for any future initialization
  console.debug('Commentary system initialized');
}
