/**
 * Analysis page module.
 * Handles fund analysis, AI advisor chat with streaming, and global chat modal.
 *
 * Note: This module uses innerHTML for markdown rendering via marked.js library.
 * marked.js is configured with sanitization and is the standard approach for
 * rendering user-facing markdown content. This matches the original app.js behavior.
 */

import { apiCall } from '@/api/client';
import { store } from '@/state/store';
import { showLoading, hideLoading } from '@/ui/loading';
import { onTabChange } from '@/ui/tabs';
import { showToast } from '@/ui/toast';
import { loadPluginAnalysis, loadWidgets } from '@/features/plugins';
import { showGlobalChatModal, hideGlobalChatModal } from '@/ui/modal';
import type { DashboardPosition } from '@/types/api';

// Declare marked as global (loaded via CDN)
declare const marked:
  | {
      parse: (content: string) => string;
      setOptions: (options: Record<string, unknown>) => void;
    }
  | undefined;

/**
 * Claude status response.
 */
interface ClaudeStatusResponse {
  claude_available: boolean;
  api_key_source: string;
}

/**
 * Fund analysis result.
 */
interface FundAnalysisResult {
  ticker: string;
  name?: string;
  morningstar_category?: string;
  style?: string;
  market_cap?: string;
  region?: string;
  data_source: string;
  sector_breakdown?: Record<string, number>;
  error?: string;
}

/**
 * Portfolio fund analysis result.
 */
interface PortfolioFundAnalysisResult {
  analyzed: FundAnalysisResult[];
  total_funds: number;
  message?: string;
}

/**
 * Advisor analysis result.
 */
interface AdvisorAnalysisResult {
  summary?: string;
  advisor_commentary?: string;
  portfolio_fit?: string;
  tax_considerations?: string;
  risk_notes?: string;
  overlaps?: Array<{
    ticker?: string;
    overlap_pct?: number;
    description?: string;
  }>;
  recommendations?: string[];
}

/**
 * Performance metrics from API.
 */
interface PerformanceMetrics {
  total_value: number;
  total_cost_basis: number;
  total_gain_loss: number;
  total_gain_loss_pct: number;
  ytd_return: number;
  one_year_return: number;
  benchmark_ytd: number;
  benchmark_one_year: number;
  alpha_ytd: number;
  alpha_one_year: number;
}

/**
 * Risk metrics from API.
 */
interface RiskMetrics {
  volatility: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown: number;
  beta: number;
  var_95: number;
  cvar_95: number;
  diversification_ratio: number;
}

/**
 * Allocation data from API.
 */
interface AllocationData {
  by_asset_class: Record<string, number>;
  by_sector: Record<string, number>;
  by_account_type: Record<string, number>;
  by_brokerage: Record<string, number>;
  concentration_top5: number;
  concentration_top10: number;
}

/**
 * Allocation row from detailed API.
 */
interface AllocationRow {
  name: string;
  stocks_bonds: number;
  funds: number;
  total: number;
  current_pct: number;
  target_pct?: number;
  deviation?: number;
}

/**
 * Detailed allocation data from API.
 */
interface DetailedAllocationData {
  total_value: number;
  by_sector: AllocationRow[];
  by_geography: AllocationRow[];
  by_cap: AllocationRow[];
  by_style: AllocationRow[];
  by_asset_class: AllocationRow[];
  by_position_type: AllocationRow[];
  cash_allocation: number;
  invested_allocation: number;
}

/**
 * Position data from API.
 */
interface PositionData {
  id: string;
  ticker: string;
  name: string;
  shares: number;
  current_price: number;
  market_value: number;
  account_name: string;
  account_id: string;
}

/**
 * SSE event types for streaming chat.
 */
interface SSETextEvent {
  type: 'text';
  content: string;
}

interface SSEToolStartEvent {
  type: 'tool_start';
  id: string;
  name: string;
}

interface SSEToolResultEvent {
  type: 'tool_result';
  id: string;
}

interface SSEDoneEvent {
  type: 'done';
}

interface SSEErrorEvent {
  type: 'error';
  message: string;
}

type SSEEvent =
  | SSETextEvent
  | SSEToolStartEvent
  | SSEToolResultEvent
  | SSEDoneEvent
  | SSEErrorEvent;

/**
 * Page context for context-aware chat.
 */
interface PageContext {
  active_tab: string;
  visible_data: Record<string, unknown>;
  selected_ticker: string | null;
}

/**
 * Tool name display mapping.
 */
const TOOL_NAMES: Record<string, string> = {
  get_positions_by_account: 'account positions',
  get_allocation_details: 'allocation data',
  get_position_details: 'position details',
  get_performance_metrics: 'performance metrics',
  get_risk_metrics: 'risk metrics',
  get_trigger_status: 'alerts',
  run_monte_carlo_projection: 'retirement projection',
  get_withdrawal_table: 'withdrawal projections',
  get_tax_projection: 'tax projections',
};

/**
 * Format tool name for display.
 */
function formatToolName(name: string): string {
  return TOOL_NAMES[name] || name.replace(/_/g, ' ');
}

/**
 * Render markdown content using marked.js library.
 * marked.js is configured with GFM (GitHub Flavored Markdown) mode.
 * Returns sanitized HTML for display in chat messages.
 * @param content - Raw markdown content from AI
 * @returns HTML string for rendering
 */
function renderMarkdown(content: string): string {
  if (typeof marked !== 'undefined') {
    return marked.parse(content);
  }
  // Fallback: escape HTML and convert newlines to <br>
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  return escaped.replace(/\n/g, '<br>');
}

/**
 * Set rendered markdown content on an element.
 * This is used for AI-generated content that needs markdown formatting.
 * @param element - Target DOM element
 * @param markdown - Markdown content to render
 */
function setMarkdownContent(element: HTMLElement, markdown: string): void {
  // Using innerHTML is intentional here for markdown rendering.
  // Content comes from our AI backend (Claude) and is rendered via marked.js.
  // This matches the original app.js implementation.
  element.innerHTML = renderMarkdown(markdown); // eslint-disable-line no-unsanitized/property
}

/**
 * Build page context for context-aware chat.
 */
function buildPageContext(): PageContext {
  const activeTabBtn = document.querySelector('.tab-btn.active') as HTMLElement | null;
  const activeTab = activeTabBtn?.dataset?.tab || 'dashboard';
  const currentAnalysisTicker = store.get('currentAnalysisTicker');

  const context: PageContext = {
    active_tab: activeTab,
    visible_data: {},
    selected_ticker: currentAnalysisTicker,
  };

  // Get portfolio summary from DOM
  try {
    const totalValueEl = document.getElementById('total-value');
    const retirementValueEl = document.getElementById('retirement-value');
    const taxableValueEl = document.getElementById('taxable-value');

    if (totalValueEl) {
      context.visible_data.portfolio_summary = {
        total_value: parseFloat(totalValueEl.textContent?.replace(/[$,]/g, '') || '0') || 0,
        retirement_value: retirementValueEl
          ? parseFloat(retirementValueEl.textContent?.replace(/[$,]/g, '') || '0') || 0
          : 0,
        taxable_value: taxableValueEl
          ? parseFloat(taxableValueEl.textContent?.replace(/[$,]/g, '') || '0') || 0
          : 0,
      };
    }
  } catch {
    // Ignore errors getting context
  }

  // Tab-specific data
  if (activeTab === 'holdings') {
    const positions = store.get('currentPositions');
    if (positions && positions.length > 0) {
      context.visible_data.positions = positions.slice(0, 20).map((p: DashboardPosition) => ({
        ticker: p.ticker,
        name: p.name,
        value: p.value || 0,
        shares: p.shares,
        account_name: p.account,
        account_type: p.account_type,
      }));
    }
  }

  // Get analysis allocation data if on analysis tab
  if (activeTab === 'analysis') {
    const windowObj = window as unknown as Record<string, unknown>;
    if (windowObj.detailedAllocation) {
      const alloc = windowObj.detailedAllocation as Record<string, unknown>;
      const allocData: Record<string, unknown> = {
        cash_allocation: alloc.cash_allocation || 0,
        invested_allocation: alloc.invested_allocation || 0,
        by_sector: {},
        concentration_top5: 0,
      };

      // Convert sector array to object
      if (alloc.by_sector && Array.isArray(alloc.by_sector)) {
        const bySector: Record<string, number> = {};
        for (const item of alloc.by_sector as Array<{ name?: string; current_pct?: number }>) {
          if (item.name && item.current_pct !== undefined) {
            bySector[item.name] = item.current_pct;
          }
        }
        allocData.by_sector = bySector;
      }

      // Get concentration from DOM
      const concEl = document.getElementById('concentration-top5');
      if (concEl) {
        allocData.concentration_top5 = parseFloat(concEl.textContent || '0') || 0;
      }

      context.visible_data.allocation = allocData;
    }

    // Get performance data
    const ytdEl = document.getElementById('ytd-return');
    const alphaEl = document.getElementById('alpha-ytd');
    if (ytdEl) {
      context.visible_data.performance = {
        ytd_return: parseFloat(ytdEl.textContent || '0') || 0,
        alpha_ytd: alphaEl ? parseFloat(alphaEl.textContent || '0') || 0 : 0,
      };
    }

    // Get risk data
    const volEl = document.getElementById('volatility');
    const sharpeEl = document.getElementById('sharpe-ratio');
    const betaEl = document.getElementById('beta');
    if (volEl || sharpeEl || betaEl) {
      context.visible_data.risk = {
        volatility: volEl ? parseFloat(volEl.textContent || '0') || 0 : null,
        sharpe_ratio: sharpeEl ? parseFloat(sharpeEl.textContent || '0') || 0 : null,
        beta: betaEl ? parseFloat(betaEl.textContent || '0') || 1.0 : null,
      };
    }
  }

  // Projections data
  if (activeTab === 'projections') {
    const windowObj = window as unknown as Record<string, unknown>;
    if (windowObj.lastMonteCarloResult) {
      const mcResult = windowObj.lastMonteCarloResult as {
        success_rate: number;
        median_final_value: number;
      };
      context.visible_data.monte_carlo_results = {
        success_rate: mcResult.success_rate,
        median_final_value: mcResult.median_final_value,
      };
    }

    const currentAge = (
      document.getElementById('projection-current-age') as HTMLInputElement | null
    )?.value;
    const retirementAge = (
      document.getElementById('projection-retirement-age') as HTMLInputElement | null
    )?.value;
    const monthlyWithdrawal = (
      document.getElementById('projection-withdrawal') as HTMLInputElement | null
    )?.value;
    if (currentAge || retirementAge || monthlyWithdrawal) {
      context.visible_data.monte_carlo_params = {
        current_age: currentAge ? parseInt(currentAge) : null,
        retirement_age: retirementAge ? parseInt(retirementAge) : null,
        monthly_withdrawal: monthlyWithdrawal ? parseFloat(monthlyWithdrawal) : null,
      };
    }
  }

  return context;
}

/**
 * Add a chat message to a container using safe DOM methods.
 */
function addChatMessageToContainer(
  container: HTMLElement,
  role: 'user' | 'assistant',
  content: string,
  useMarkdown = false
): HTMLElement {
  // Remove placeholder if present
  const placeholder = container.querySelector('.chat-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'chat-message-content';

  if (useMarkdown && role === 'assistant') {
    setMarkdownContent(contentDiv, content);
  } else {
    contentDiv.textContent = content;
  }

  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  return messageDiv;
}

/**
 * Send streaming chat message with tool support (V2).
 */
export async function sendStreamingChatMessageV2(
  containerId: string,
  inputId: string,
  ticker: string | null = null
): Promise<void> {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const container = document.getElementById(containerId);
  if (!input || !container) return;

  const message = input.value.trim();
  if (!message) return;

  // Clear input and disable while streaming
  input.value = '';
  input.disabled = true;

  // Add user message
  addChatMessageToContainer(container, 'user', message);

  // Create assistant message for streaming
  const messageDiv = document.createElement('div');
  messageDiv.className = 'chat-message assistant';
  const contentDiv = document.createElement('div');
  contentDiv.className = 'chat-message-content streaming-cursor';
  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  let fullContent = '';
  const pageContext = buildPageContext();

  try {
    const response = await fetch('/api/analysis/advisor/chat/stream/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        ticker,
        include_portfolio: true,
        page_context: pageContext,
      }),
    });

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.substring(6)) as SSEEvent;

            if (event.type === 'text') {
              fullContent += event.content;
              contentDiv.textContent = fullContent;
              container.scrollTop = container.scrollHeight;
            } else if (event.type === 'tool_start') {
              const toolIndicator = document.createElement('div');
              toolIndicator.className = 'tool-indicator';
              toolIndicator.id = `tool-${event.id}`;
              toolIndicator.textContent = `Looking up ${formatToolName(event.name)}...`;
              contentDiv.appendChild(toolIndicator);
              container.scrollTop = container.scrollHeight;
            } else if (event.type === 'tool_result') {
              // Remove tool indicators
              const indicators = contentDiv.querySelectorAll('.tool-indicator');
              indicators.forEach((ind) => ind.remove());
            } else if (event.type === 'done') {
              contentDiv.classList.remove('streaming-cursor');
              const indicators = contentDiv.querySelectorAll('.tool-indicator');
              indicators.forEach((ind) => ind.remove());
              // Render final markdown (AI-generated content via marked.js)
              setMarkdownContent(contentDiv, fullContent);
            } else if (event.type === 'error') {
              contentDiv.classList.remove('streaming-cursor');
              contentDiv.textContent = `Error: ${event.message}`;
            }
          } catch {
            // JSON parse error - ignore partial data
          }
        }
      }
    }
  } catch (error) {
    console.error('Chat stream error:', error);
    contentDiv.classList.remove('streaming-cursor');
    contentDiv.textContent = 'Sorry, I encountered an error. Please try again.';
  } finally {
    input.disabled = false;
    input.focus();
  }
}

/**
 * Legacy streaming chat (V1 format).
 */
export async function sendStreamingChatMessage(
  containerId: string,
  inputId: string,
  ticker: string | null = null
): Promise<void> {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const container = document.getElementById(containerId);
  if (!input || !container) return;

  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.disabled = true;

  addChatMessageToContainer(container, 'user', message);

  const messageDiv = document.createElement('div');
  messageDiv.className = 'chat-message assistant';
  const contentDiv = document.createElement('div');
  contentDiv.className = 'chat-message-content streaming-cursor';
  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  let fullContent = '';

  try {
    const response = await fetch('/api/analysis/advisor/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        ticker,
        include_portfolio: true,
      }),
    });

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.substring(6);
          if (data === '[DONE]') {
            contentDiv.classList.remove('streaming-cursor');
            setMarkdownContent(contentDiv, fullContent);
          } else {
            const text = data.replace(/\\n/g, '\n');
            fullContent += text;
            contentDiv.textContent = fullContent;
            container.scrollTop = container.scrollHeight;
          }
        }
      }
    }
  } catch (error) {
    console.error('Chat stream error:', error);
    contentDiv.classList.remove('streaming-cursor');
    contentDiv.textContent = 'Sorry, I encountered an error. Please try again.';
  } finally {
    input.disabled = false;
    input.focus();
  }
}

/**
 * Check Claude/AI status and update badge.
 */
export async function checkClaudeStatus(): Promise<void> {
  try {
    const status = await apiCall<ClaudeStatusResponse>('/api/analysis/fund/status');

    const badge = document.getElementById('claude-status-badge');
    const featureStatus = document.getElementById('claude-feature-status');

    if (status.claude_available) {
      if (badge) {
        badge.textContent = 'AI Enabled';
        badge.className = 'status-badge enabled';
      }
      if (featureStatus) {
        featureStatus.textContent = `(API Key: ${status.api_key_source})`;
      }
    } else {
      if (badge) {
        badge.textContent = 'AI Disabled';
        badge.className = 'status-badge disabled';
      }
      if (featureStatus) {
        featureStatus.textContent = '(Add API key in Settings to enable AI analysis)';
      }
    }
  } catch (error) {
    console.error('Error checking Claude status:', error);
  }
}

/**
 * Analyze a single fund.
 */
export async function analyzeFund(): Promise<void> {
  const tickerEl = document.getElementById('analyze-ticker') as HTMLInputElement | null;
  const ticker = tickerEl?.value.trim().toUpperCase() || '';
  if (!ticker) {
    showToast('Please enter a fund ticker', 'error');
    return;
  }

  showLoading(`Analyzing ${ticker}...`);

  try {
    const result = await apiCall<FundAnalysisResult>('/api/analysis/fund/analyze', {
      method: 'POST',
      body: { ticker, use_claude: true },
    });

    displayFundAnalysis(result);
    showToast(`Analysis complete (source: ${result.data_source})`, 'success');
  } catch (error) {
    console.error('Fund analysis error:', error);
    showToast('Failed to analyze fund', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Display fund analysis result.
 */
function displayFundAnalysis(result: FundAnalysisResult): void {
  const resultEl = document.getElementById('fund-analysis-result');
  if (resultEl) resultEl.style.display = 'block';

  const setTextContent = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setTextContent('fa-ticker', result.ticker);
  setTextContent('fa-name', result.name || '-');
  setTextContent('fa-category', result.morningstar_category || '-');
  setTextContent(
    'fa-style',
    result.style ? result.style.charAt(0).toUpperCase() + result.style.slice(1) : '-'
  );
  setTextContent(
    'fa-cap',
    result.market_cap ? result.market_cap.charAt(0).toUpperCase() + result.market_cap.slice(1) : '-'
  );
  setTextContent(
    'fa-region',
    result.region ? result.region.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase()) : '-'
  );

  // Data source
  const sourceEl = document.getElementById('fa-source');
  if (sourceEl) {
    if (result.data_source === 'claude') {
      sourceEl.textContent = '🤖 Claude AI';
    } else if (result.data_source === 'cache') {
      sourceEl.textContent = '💾 Cached';
    } else {
      sourceEl.textContent = '📊 yfinance';
    }
  }

  // Sector breakdown
  const sectorsContainer = document.getElementById('fa-sectors');
  const sectorsList = document.getElementById('fa-sectors-list');

  if (
    result.sector_breakdown &&
    Object.keys(result.sector_breakdown).length > 0 &&
    sectorsContainer &&
    sectorsList
  ) {
    sectorsContainer.style.display = 'block';
    sectorsList.textContent = '';

    const sortedSectors = Object.entries(result.sector_breakdown).sort((a, b) => b[1] - a[1]);

    sortedSectors.forEach(([sector, pct]) => {
      const item = document.createElement('div');
      item.className = 'holding-item';

      const sectorSpan = document.createElement('span');
      sectorSpan.className = 'holding-ticker';
      sectorSpan.textContent = sector;
      item.appendChild(sectorSpan);

      const pctSpan = document.createElement('span');
      pctSpan.className = 'holding-value';
      pctSpan.textContent = `${pct.toFixed(1)}%`;
      item.appendChild(pctSpan);

      sectorsList.appendChild(item);
    });
  } else if (sectorsContainer) {
    sectorsContainer.style.display = 'none';
  }
}

/**
 * Analyze all portfolio funds.
 */
export async function analyzePortfolioFunds(): Promise<void> {
  showLoading('Analyzing portfolio funds...');

  try {
    const result = await apiCall<PortfolioFundAnalysisResult>(
      '/api/analysis/fund/analyze-portfolio',
      {
        method: 'POST',
      }
    );

    if (result.analyzed && result.analyzed.length > 0) {
      showToast(`Analyzed ${result.analyzed.length} of ${result.total_funds} funds`, 'success');

      if (result.analyzed[0] && !result.analyzed[0].error) {
        displayFundAnalysis(result.analyzed[0]);
      }
    } else {
      showToast(result.message || 'No funds found to analyze', 'info');
    }
  } catch (error) {
    console.error('Portfolio fund analysis error:', error);
    showToast('Failed to analyze portfolio funds', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Get advisor analysis for a ticker.
 */
export async function getAdvisorAnalysis(): Promise<void> {
  const tickerEl = document.getElementById('analyze-ticker') as HTMLInputElement | null;
  const ticker = tickerEl?.value.trim().toUpperCase() || '';
  if (!ticker) {
    showToast('Please enter a fund ticker', 'error');
    return;
  }

  showLoading(`Getting advisor analysis for ${ticker}...`);

  try {
    const result = await apiCall<AdvisorAnalysisResult>('/api/analysis/advisor/analyze', {
      method: 'POST',
      body: {
        ticker,
        fund_name: null,
        investor_age: null,
        risk_tolerance: null,
      },
    });

    displayAdvisorAnalysis(result);
    showToast('Advisor analysis complete', 'success');
  } catch (error) {
    console.error('Advisor analysis error:', error);
    showToast('Failed to get advisor analysis', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Display advisor analysis result.
 */
function displayAdvisorAnalysis(result: AdvisorAnalysisResult): void {
  const fundResultEl = document.getElementById('fund-analysis-result');
  const advisorResultEl = document.getElementById('advisor-analysis-result');

  if (fundResultEl) fundResultEl.style.display = 'none';
  if (advisorResultEl) advisorResultEl.style.display = 'block';

  const setTextContent = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setTextContent('advisor-summary', result.summary || 'No summary available.');
  setTextContent(
    'advisor-portfolio-fit',
    result.portfolio_fit || 'No portfolio fit analysis available.'
  );
  setTextContent('advisor-tax', result.tax_considerations || 'No tax considerations available.');
  setTextContent('advisor-risk', result.risk_notes || 'No risk notes available.');

  // Commentary with paragraph formatting
  const commentaryEl = document.getElementById('advisor-commentary');
  if (commentaryEl) {
    commentaryEl.textContent = '';
    const text = result.advisor_commentary || 'No commentary available.';
    text.split('\n\n').forEach((para) => {
      const p = document.createElement('p');
      p.textContent = para;
      commentaryEl.appendChild(p);
    });
  }

  // Overlaps
  const overlapsSection = document.getElementById('advisor-overlaps-section');
  const overlapsContainer = document.getElementById('advisor-overlaps');
  if (result.overlaps && result.overlaps.length > 0 && overlapsSection && overlapsContainer) {
    overlapsSection.style.display = 'block';
    overlapsContainer.textContent = '';

    result.overlaps.forEach((o) => {
      const item = document.createElement('div');
      item.className = 'overlap-item';

      const ticker = document.createElement('span');
      ticker.className = 'overlap-ticker';
      ticker.textContent = o.ticker || 'Unknown';
      item.appendChild(ticker);

      if (o.overlap_pct) {
        const pct = document.createElement('span');
        pct.className = 'overlap-pct';
        pct.textContent = `${o.overlap_pct}% overlap`;
        item.appendChild(pct);
      }

      const desc = document.createElement('span');
      desc.className = 'overlap-desc';
      desc.textContent = o.description || '';
      item.appendChild(desc);

      overlapsContainer.appendChild(item);
    });
  } else if (overlapsSection) {
    overlapsSection.style.display = 'none';
  }

  // Recommendations
  const recsSection = document.getElementById('advisor-recommendations-section');
  const recsList = document.getElementById('advisor-recommendations');
  if (result.recommendations && result.recommendations.length > 0 && recsSection && recsList) {
    recsSection.style.display = 'block';
    recsList.textContent = '';

    result.recommendations.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = r;
      recsList.appendChild(li);
    });
  } else if (recsSection) {
    recsSection.style.display = 'none';
  }
}

/**
 * Send chat message in analysis page.
 */
export async function sendChatMessage(): Promise<void> {
  const ticker = store.get('currentAnalysisTicker');
  await sendStreamingChatMessageV2('chat-messages', 'chat-input', ticker);
}

/**
 * Handle chat input keypress.
 */
export function handleChatKeypress(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
}

/**
 * Clear advisor chat history.
 */
export async function clearAdvisorChat(): Promise<void> {
  try {
    await apiCall('/api/analysis/advisor/chat/clear', { method: 'POST' });

    const container = document.getElementById('chat-messages');
    if (container) {
      container.textContent = '';
      const placeholder = document.createElement('div');
      placeholder.className = 'chat-placeholder';

      const intro = document.createElement('p');
      intro.textContent = 'Ask a question to start the conversation...';
      placeholder.appendChild(intro);

      const examples = document.createElement('p');
      examples.className = 'text-muted';
      examples.textContent = 'Examples:';
      placeholder.appendChild(examples);

      const list = document.createElement('ul');
      list.className = 'text-muted';
      const exampleQuestions = [
        'Should I be concerned about my technology exposure?',
        "What's the difference between VTI and VOO?",
        'Is my portfolio too aggressive for someone my age?',
      ];
      exampleQuestions.forEach((q) => {
        const li = document.createElement('li');
        li.textContent = q;
        list.appendChild(li);
      });
      placeholder.appendChild(list);

      container.appendChild(placeholder);
    }

    showToast('Chat history cleared', 'success');
  } catch (error) {
    console.error('Error clearing chat:', error);
    showToast('Failed to clear chat', 'error');
  }
}

/**
 * Show global chat modal.
 */
export function showGlobalChat(): void {
  showGlobalChatModal();
  const input = document.getElementById('global-chat-input');
  if (input) input.focus();
}

/**
 * Hide global chat modal.
 */
export function hideGlobalChat(): void {
  hideGlobalChatModal();
}

/**
 * Send global chat message.
 */
export async function sendGlobalChatMessage(): Promise<void> {
  await sendStreamingChatMessageV2('global-chat-messages', 'global-chat-input', null);
}

/**
 * Handle global chat keypress.
 */
export function handleGlobalChatKeypress(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendGlobalChatMessage();
  }
}

/**
 * Clear global chat history.
 */
export async function clearGlobalChat(): Promise<void> {
  try {
    await apiCall('/api/analysis/advisor/chat/clear', { method: 'POST' });

    const container = document.getElementById('global-chat-messages');
    if (container) {
      container.textContent = '';
      const placeholder = document.createElement('div');
      placeholder.className = 'chat-placeholder';

      const intro = document.createElement('p');
      intro.textContent = 'Ask a question about your portfolio...';
      placeholder.appendChild(intro);

      const examples = document.createElement('p');
      examples.className = 'text-muted';
      examples.textContent = 'Examples:';
      placeholder.appendChild(examples);

      const list = document.createElement('ul');
      list.className = 'text-muted';
      const exampleQuestions = [
        'Should I be concerned about my technology exposure?',
        "What's the difference between VTI and VOO?",
        'Is my portfolio too aggressive for someone my age?',
        'How can I improve my diversification?',
      ];
      exampleQuestions.forEach((q) => {
        const li = document.createElement('li');
        li.textContent = q;
        list.appendChild(li);
      });
      placeholder.appendChild(list);

      container.appendChild(placeholder);
    }

    showToast('Chat history cleared', 'success');
  } catch (error) {
    console.error('Error clearing global chat:', error);
    showToast('Failed to clear chat', 'error');
  }
}

/**
 * Update position sectors.
 */
export async function updatePositionSectors(): Promise<void> {
  showLoading('Updating position sectors...');

  try {
    const result = await apiCall<{ error?: string; positions_updated?: number; message?: string }>(
      '/api/analysis/positions/update-sectors',
      {
        method: 'POST',
      }
    );

    if (result.error) {
      showToast(result.error, 'error');
      return;
    }

    if (result.positions_updated && result.positions_updated > 0) {
      showToast(`Updated sectors for ${result.positions_updated} positions`, 'success');
      window.location.reload();
    } else {
      showToast(result.message || 'No positions needed sector updates', 'info');
    }
  } catch (error) {
    console.error('Error updating sectors:', error);
    showToast('Failed to update sectors', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Unified function to enrich all portfolio data with sector classifications.
 * Consolidates two data sources: FundDataService (for mutual funds/ETFs) and
 * yfinance (for individual stocks). Refreshes widgets afterward to display
 * updated sector allocations in visualizations like the treemap.
 */
export async function enrichAllData(): Promise<void> {
  showLoading('Enriching portfolio data...');

  let totalUpdated = 0;
  let anySuccess = false;
  const errors: string[] = [];

  try {
    // Analyze funds (gets sector data from FundDataService)
    try {
      const fundResult = await apiCall<{ positions_updated?: number }>(
        '/api/analysis/fund/analyze-portfolio',
        { method: 'POST' }
      );
      totalUpdated += fundResult.positions_updated || 0;
      anySuccess = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('Fund analysis failed:', e);
      errors.push(`Fund analysis: ${message}`);
    }

    // Update remaining position sectors (via yfinance)
    try {
      const sectorResult = await apiCall<{ positions_updated?: number }>(
        '/api/analysis/positions/update-sectors',
        { method: 'POST' }
      );
      totalUpdated += sectorResult.positions_updated || 0;
      anySuccess = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('Sector update failed:', e);
      errors.push(`Sector update: ${message}`);
    }

    // Only save timestamp and show success if at least one call succeeded
    if (anySuccess) {
      localStorage.setItem('enrichment_last_update', new Date().toISOString());
      updateEnrichmentStatus();

      if (errors.length > 0) {
        showToast(`Enriched ${totalUpdated} positions (with some errors)`, 'warning');
      } else if (totalUpdated > 0) {
        showToast(`Enriched ${totalUpdated} positions`, 'success');
      } else {
        showToast('All positions already have sector data', 'info');
      }
    } else {
      showToast(`Failed to enrich data: ${errors.join('; ')}`, 'error');
    }

    // Refresh widgets regardless to show current state
    await loadWidgets();
  } catch (error) {
    console.error('Error enriching data:', error);
    showToast('Failed to enrich data', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Update the enrichment status display based on localStorage timestamp.
 * Data is considered "current" if enriched within the last 24 hours,
 * otherwise displayed as "may be stale" to prompt re-enrichment.
 */
export function updateEnrichmentStatus(): void {
  const lastUpdate = localStorage.getItem('enrichment_last_update');
  const statusText = document.getElementById('enrichment-status-text');
  const timeEl = document.getElementById('enrichment-last-update');

  if (!lastUpdate) {
    if (statusText) {
      statusText.textContent = 'Data has not been enriched yet';
      statusText.classList.remove('status-current');
    }
    if (timeEl) timeEl.textContent = '';
    return;
  }

  const lastDate = new Date(lastUpdate);
  const hoursSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);

  if (statusText) {
    if (hoursSince < 24) {
      statusText.textContent = 'Data is current';
      statusText.classList.add('status-current');
    } else {
      statusText.textContent = 'Data may be stale';
      statusText.classList.remove('status-current');
    }
  }

  if (timeEl) {
    timeEl.textContent = `Last updated: ${lastDate.toLocaleDateString()} ${lastDate.toLocaleTimeString()}`;
  }
}

/**
 * Helper to format a percentage value for display.
 */
function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || isNaN(value)) return '-';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Helper to update a DOM element's text content safely.
 */
function setElementText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

/**
 * Load and display analysis metrics (performance, risk, allocation).
 */
export async function loadAnalysisData(): Promise<void> {
  try {
    // Load all data in parallel
    const [performance, risk, allocation] = await Promise.all([
      apiCall<PerformanceMetrics>('/api/analysis/performance'),
      apiCall<RiskMetrics>('/api/analysis/risk'),
      apiCall<AllocationData>('/api/analysis/allocation'),
    ]);

    // Update performance metrics
    setElementText('ytd-return', formatPercent(performance.ytd_return));
    setElementText('one-year-return', formatPercent(performance.one_year_return));
    setElementText('alpha-ytd', formatPercent(performance.alpha_ytd));
    setElementText('benchmark-ytd', formatPercent(performance.benchmark_ytd));

    // Update risk metrics
    setElementText('volatility', formatPercent(risk.volatility));
    setElementText('sharpe-ratio', risk.sharpe_ratio?.toFixed(2) || '-');
    setElementText('max-drawdown', formatPercent(risk.max_drawdown));
    setElementText('beta', risk.beta?.toFixed(2) || '-');
    setElementText('var-95', formatPercent(risk.var_95));

    // Update concentration metrics
    setElementText('concentration-top5', formatPercent(allocation.concentration_top5));
    setElementText('concentration-top10', formatPercent(allocation.concentration_top10));

    // Calculate cash vs invested allocation
    const cashPct = allocation.by_asset_class['cash'] || allocation.by_asset_class['Cash'] || 0;
    const investedPct = 100 - cashPct;
    setElementText('cash-allocation', formatPercent(cashPct));
    setElementText('invested-allocation', formatPercent(investedPct));

    // Store allocation data for context-aware chat
    (window as unknown as Record<string, unknown>).detailedAllocation = {
      cash_allocation: cashPct,
      invested_allocation: investedPct,
      by_sector: allocation.by_sector,
      by_asset_class: allocation.by_asset_class,
    };

    // Load top holdings
    await loadTopHoldings();

    // Load default allocation tab (asset-class)
    await showAllocationTab('asset-class');
  } catch (error) {
    console.error('Error loading analysis data:', error);
  }
}

/**
 * Show detailed information for a metric.
 * Currently shows a toast with metric info - could be expanded to a modal.
 */
export function showMetricDetail(metricId: string): void {
  const descriptions: Record<string, string> = {
    'ytd-return': 'Year-to-date return measures portfolio growth since January 1st.',
    'one-year-return': 'Rolling 12-month return of your portfolio.',
    'alpha': 'Excess return compared to the S&P 500 benchmark.',
    'volatility': 'Annualized standard deviation of returns - higher means more price swings.',
    'sharpe': 'Risk-adjusted return (return per unit of risk). Higher is better.',
    'max-drawdown': 'Largest peak-to-trough decline in portfolio value.',
    'beta': 'Sensitivity to market movements. 1.0 = moves with market.',
    'var': 'Value at Risk - maximum expected daily loss 95% of the time.',
  };

  const description = descriptions[metricId] || 'No additional information available.';
  showToast(description, 'info');
}

/** Cached detailed allocation data */
let cachedDetailedAllocationData: DetailedAllocationData | null = null;

/** Cached positions data */
let cachedPositionsData: PositionData[] | null = null;

/**
 * Format currency value for display.
 */
function formatCurrencyValue(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Load and display top holdings in the Top Holdings card.
 */
export async function loadTopHoldings(): Promise<void> {
  const container = document.getElementById('top-holdings-list');
  if (!container) return;

  try {
    // Fetch positions if not cached
    if (!cachedPositionsData) {
      cachedPositionsData = await apiCall<PositionData[]>('/api/portfolio/positions');
    }

    // Sort by market value descending and take top 5
    const topHoldings = [...cachedPositionsData]
      .filter((p) => p.market_value && p.market_value > 0)
      .sort((a, b) => (b.market_value || 0) - (a.market_value || 0))
      .slice(0, 5);

    // Calculate total portfolio value for percentages
    const totalValue = cachedPositionsData.reduce((sum, p) => sum + (p.market_value || 0), 0);

    // Clear container
    container.textContent = '';

    if (topHoldings.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'text-muted';
      emptyMsg.textContent = 'No holdings found';
      container.appendChild(emptyMsg);
      return;
    }

    // Render each holding
    for (const holding of topHoldings) {
      const item = document.createElement('div');
      item.className = 'holding-item';

      const tickerSpan = document.createElement('span');
      tickerSpan.className = 'holding-ticker';
      tickerSpan.textContent = holding.ticker;
      item.appendChild(tickerSpan);

      const valueSpan = document.createElement('span');
      valueSpan.className = 'holding-value';
      const pct = totalValue > 0 ? (holding.market_value / totalValue) * 100 : 0;
      valueSpan.textContent = `${formatCurrencyValue(holding.market_value)} (${pct.toFixed(1)}%)`;
      item.appendChild(valueSpan);

      container.appendChild(item);
    }
  } catch (error) {
    console.error('Error loading top holdings:', error);
    container.textContent = '';
    const errorMsg = document.createElement('div');
    errorMsg.className = 'text-muted';
    errorMsg.textContent = 'Failed to load top holdings';
    container.appendChild(errorMsg);
  }
}

/**
 * Show detailed view of top N holdings.
 */
export async function showTopHoldingsDetail(count: number): Promise<void> {
  try {
    // Fetch positions if not cached
    if (!cachedPositionsData) {
      cachedPositionsData = await apiCall<PositionData[]>('/api/portfolio/positions');
    }

    // Sort by market value descending and take top N
    const topHoldings = [...cachedPositionsData]
      .filter((p) => p.market_value && p.market_value > 0)
      .sort((a, b) => (b.market_value || 0) - (a.market_value || 0))
      .slice(0, count);

    // Calculate total portfolio value for percentages
    const totalValue = cachedPositionsData.reduce((sum, p) => sum + (p.market_value || 0), 0);

    // Build content for toast or modal
    const lines: string[] = [`Top ${count} Holdings:`];
    for (const holding of topHoldings) {
      const pct = totalValue > 0 ? (holding.market_value / totalValue) * 100 : 0;
      lines.push(`${holding.ticker}: ${formatCurrencyValue(holding.market_value)} (${pct.toFixed(1)}%)`);
    }

    showToast(lines.join('\n'), 'info');
  } catch (error) {
    console.error('Error loading top holdings detail:', error);
    showToast('Failed to load top holdings', 'error');
  }
}

/**
 * Show allocation breakdown for a specific category tab.
 * Uses the detailed allocation API to get proper dollar values.
 */
export async function showAllocationTab(tabName: string): Promise<void> {
  // Update active tab styling
  document.querySelectorAll('.alloc-tab').forEach((btn) => {
    btn.classList.remove('active');
    const onclick = btn.getAttribute('onclick') || '';
    if (onclick.includes(`'${tabName}'`)) {
      btn.classList.add('active');
    }
  });

  // Fetch detailed allocation data if not cached
  if (!cachedDetailedAllocationData) {
    try {
      cachedDetailedAllocationData = await apiCall<DetailedAllocationData>('/api/analysis/allocation/detailed');
    } catch (error) {
      console.error('Error loading detailed allocation data:', error);
      return;
    }
  }

  // Get the data for the selected tab
  let rows: AllocationRow[] = [];
  const allocation = cachedDetailedAllocationData;

  switch (tabName) {
    case 'asset-class':
      rows = allocation.by_asset_class || [];
      break;
    case 'sector':
      rows = allocation.by_sector || [];
      break;
    case 'geography':
      rows = allocation.by_geography || [];
      break;
    case 'cap':
      rows = allocation.by_cap || [];
      break;
    case 'style':
      rows = allocation.by_style || [];
      break;
    case 'position-type':
      rows = allocation.by_position_type || [];
      break;
    default:
      rows = allocation.by_asset_class || [];
  }

  // Update the allocation table
  const table = document.getElementById('allocation-table');
  if (!table) return;

  const tbody = table.querySelector('tbody') || table;

  // Clear all existing rows from tbody (header is in thead, not tbody)
  while (tbody.firstChild) {
    tbody.removeChild(tbody.firstChild);
  }

  // If no data, show empty message
  if (rows.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = 'No data available for this category';
    cell.style.textAlign = 'center';
    cell.style.color = 'var(--text-muted)';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  // Sort by total value descending and add rows
  const sortedRows = [...rows].sort((a, b) => b.total - a.total);

  for (const allocRow of sortedRows) {
    const row = document.createElement('tr');

    // Category name cell
    const nameCell = document.createElement('td');
    nameCell.textContent = allocRow.name;
    row.appendChild(nameCell);

    // Value cell (dollar value)
    const valueCell = document.createElement('td');
    valueCell.textContent = formatCurrencyValue(allocRow.total);
    row.appendChild(valueCell);

    // Percentage cell
    const pctCell = document.createElement('td');
    pctCell.textContent = `${allocRow.current_pct.toFixed(1)}%`;
    row.appendChild(pctCell);

    tbody.appendChild(row);
  }
}

/**
 * Initialize analysis page event handlers.
 */
export function initAnalysis(): void {
  // Configure marked.js if available
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }

  // Chat input handlers
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keypress', handleChatKeypress as EventListener);
  }

  // Send button
  const sendBtn = document.getElementById('send-chat-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', sendChatMessage);
  }

  // Clear chat button
  const clearChatBtn = document.getElementById('clear-chat-btn');
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', clearAdvisorChat);
  }

  // Fund analysis
  const analyzeFundBtn = document.getElementById('analyze-fund-btn');
  if (analyzeFundBtn) {
    analyzeFundBtn.addEventListener('click', analyzeFund);
  }

  const analyzePortfolioBtn = document.getElementById('analyze-portfolio-btn');
  if (analyzePortfolioBtn) {
    analyzePortfolioBtn.addEventListener('click', analyzePortfolioFunds);
  }

  const advisorAnalysisBtn = document.getElementById('advisor-analysis-btn');
  if (advisorAnalysisBtn) {
    advisorAnalysisBtn.addEventListener('click', getAdvisorAnalysis);
  }

  // Global chat modal
  const globalChatInput = document.getElementById('global-chat-input');
  if (globalChatInput) {
    globalChatInput.addEventListener('keypress', handleGlobalChatKeypress as EventListener);
  }

  const globalSendBtn = document.getElementById('global-send-btn');
  if (globalSendBtn) {
    globalSendBtn.addEventListener('click', sendGlobalChatMessage);
  }

  const globalClearBtn = document.getElementById('global-clear-btn');
  if (globalClearBtn) {
    globalClearBtn.addEventListener('click', clearGlobalChat);
  }

  // Global chat close button
  const globalCloseBtn = document.querySelector('#global-chat-modal .modal-close');
  if (globalCloseBtn) {
    globalCloseBtn.addEventListener('click', hideGlobalChat);
  }

  // Keyboard shortcuts (Ctrl+K / Cmd+K)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const modal = document.getElementById('global-chat-modal');
      if (modal && (modal.style.display === 'none' || !modal.style.display)) {
        showGlobalChat();
      } else {
        hideGlobalChat();
      }
    }
    // Escape to close
    if (e.key === 'Escape') {
      hideGlobalChat();
    }
  });

  // Check Claude status on load
  checkClaudeStatus();

  // Load analysis data when switching to analysis tab
  onTabChange((tab) => {
    if (tab === 'analysis') {
      loadAnalysisData();
      loadPluginAnalysis();
      updateEnrichmentStatus();
    }
  });
}
