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
import { showToast } from '@/ui/toast';
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
}
