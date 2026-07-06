/**
 * Plugin System
 * Handles plugin discovery, installation, configuration, and security.
 */

import { apiCall, uploadFile, getBaseUrl } from '@/api/client';
import { generateSignatureHeaders, isSigningRequired } from '@/state/session';
import { showToast } from '@/ui/toast';
import { closeModal, createDynamicModal } from '@/ui/modal';
import { getElementById, setVisible, clearElement, createSvgElement } from '@/utils/html';
import { setStateView } from '@/ui/state-view';
import { formatNumber } from '@/utils/format';
import { emit } from '@/state/events';
import { store } from '@/state/store';

/**
 * Plugin information from API.
 */
export interface Plugin {
  plugin_id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  plugin_type: 'importer' | 'analysis' | 'widget' | 'provider' | 'export';
  enabled: boolean;
  is_builtin: boolean;
  load_error?: string;
  settings_schema?: PluginSettingSchema[];
  source?: {
    type: 'git' | 'upload';
    url?: string;
  };
}

/**
 * Plugin setting schema.
 */
interface PluginSettingSchema {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  default?: string | number | boolean;
  description?: string;
  options?: string[];
}

/**
 * Plugin settings response.
 */
interface PluginSettingsResponse {
  schema: PluginSettingSchema[];
  settings: Record<string, string | number | boolean>;
}

/**
 * Plugin security permissions.
 */
interface PluginPermissions {
  plugins: {
    plugin_id: string;
    name: string;
    is_builtin: boolean;
    approved: boolean;
    needs_approval: boolean;
    requested: {
      file_read: boolean;
      file_write: boolean;
      network: boolean;
      database: string;
    };
  }[];
  pending_count: number;
}

/**
 * Security audit entry.
 */
interface AuditEntry {
  timestamp: string;
  event_type: string;
  plugin_id: string;
  success: boolean;
}

/**
 * Audit log response.
 */
interface AuditLogResponse {
  entries: AuditEntry[];
}

/**
 * Widget content from API.
 */
interface WidgetData {
  plugin_name: string;
  success: boolean;
  error?: string;
  config?: {
    title?: string;
    default_width?: number;
    default_height?: number;
  };
  content?: {
    html?: string;
  };
}

/**
 * Plugin analysis data.
 */
interface PluginAnalysisData {
  plugins: {
    plugin_name: string;
    metrics?: Record<string, number>;
    insights?: string[];
  }[];
}

/**
 * Install response.
 */
interface InstallResponse {
  success: boolean;
  plugin_name?: string;
  version?: string;
  message?: string;
  errors?: string[];
}

/**
 * Update check response.
 */
interface UpdateCheckResponse {
  has_update: boolean;
  current_commit?: string;
  latest_commit?: string;
}

/**
 * Bulk update check response.
 */
interface BulkUpdateCheckResponse {
  count: number;
  updates_available: { plugin_id: string }[];
}

/**
 * Module state for available plugins.
 */
let availablePlugins: Plugin[] = [];

/**
 * Get available plugins.
 */
export function getAvailablePlugins(): Plugin[] {
  return availablePlugins;
}

/**
 * Create plugin type icon using SVG elements.
 */
function createPluginTypeIcon(pluginType: string): SVGSVGElement {
  const svg = createSvgElement('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');

  switch (pluginType) {
    case 'importer': {
      // Upload icon
      const path = createSvgElement('path');
      path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
      svg.appendChild(path);
      const polyline = createSvgElement('polyline');
      polyline.setAttribute('points', '17 8 12 3 7 8');
      svg.appendChild(polyline);
      const line = createSvgElement('line');
      line.setAttribute('x1', '12');
      line.setAttribute('y1', '3');
      line.setAttribute('x2', '12');
      line.setAttribute('y2', '15');
      svg.appendChild(line);
      break;
    }
    case 'analysis': {
      // Bar chart icon
      const line1 = createSvgElement('line');
      line1.setAttribute('x1', '18');
      line1.setAttribute('y1', '20');
      line1.setAttribute('x2', '18');
      line1.setAttribute('y2', '10');
      svg.appendChild(line1);
      const line2 = createSvgElement('line');
      line2.setAttribute('x1', '12');
      line2.setAttribute('y1', '20');
      line2.setAttribute('x2', '12');
      line2.setAttribute('y2', '4');
      svg.appendChild(line2);
      const line3 = createSvgElement('line');
      line3.setAttribute('x1', '6');
      line3.setAttribute('y1', '20');
      line3.setAttribute('x2', '6');
      line3.setAttribute('y2', '14');
      svg.appendChild(line3);
      break;
    }
    case 'widget': {
      // Grid icon
      const rect1 = createSvgElement('rect');
      rect1.setAttribute('x', '3');
      rect1.setAttribute('y', '3');
      rect1.setAttribute('width', '7');
      rect1.setAttribute('height', '7');
      svg.appendChild(rect1);
      const rect2 = createSvgElement('rect');
      rect2.setAttribute('x', '14');
      rect2.setAttribute('y', '3');
      rect2.setAttribute('width', '7');
      rect2.setAttribute('height', '7');
      svg.appendChild(rect2);
      const rect3 = createSvgElement('rect');
      rect3.setAttribute('x', '14');
      rect3.setAttribute('y', '14');
      rect3.setAttribute('width', '7');
      rect3.setAttribute('height', '7');
      svg.appendChild(rect3);
      const rect4 = createSvgElement('rect');
      rect4.setAttribute('x', '3');
      rect4.setAttribute('y', '14');
      rect4.setAttribute('width', '7');
      rect4.setAttribute('height', '7');
      svg.appendChild(rect4);
      break;
    }
    case 'provider': {
      // Activity icon
      const path = createSvgElement('path');
      path.setAttribute('d', 'M22 12h-4l-3 9L9 3l-3 9H2');
      svg.appendChild(path);
      break;
    }
    case 'export': {
      // Download icon
      const path = createSvgElement('path');
      path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
      svg.appendChild(path);
      const polyline = createSvgElement('polyline');
      polyline.setAttribute('points', '7 10 12 15 17 10');
      svg.appendChild(polyline);
      const line = createSvgElement('line');
      line.setAttribute('x1', '12');
      line.setAttribute('y1', '15');
      line.setAttribute('x2', '12');
      line.setAttribute('y2', '3');
      svg.appendChild(line);
      break;
    }
    default: {
      // Default to grid icon
      const rect = createSvgElement('rect');
      rect.setAttribute('x', '3');
      rect.setAttribute('y', '3');
      rect.setAttribute('width', '7');
      rect.setAttribute('height', '7');
      svg.appendChild(rect);
      break;
    }
  }

  return svg;
}

/**
 * Load plugins from API.
 */
export async function loadPlugins(): Promise<void> {
  try {
    const plugins = await apiCall<Plugin[]>('/api/plugins');
    availablePlugins = plugins;
    renderPluginsList(plugins);
  } catch (error) {
    console.error('Error loading plugins:', error);
    const container = getElementById<HTMLElement>('plugins-list');
    if (container) {
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = 'Failed to load plugins.';
      container.appendChild(p);
    }
  }
}

/**
 * Discover plugins by scanning directories.
 */
export async function discoverPlugins(): Promise<void> {
  try {
    showToast('Scanning for plugins...', 'info');
    const result = await apiCall<{ discovered: number }>('/api/plugins/discover', {
      method: 'POST',
    });
    showToast('Found ' + result.discovered + ' plugins', 'success');
    await loadPlugins();
  } catch (error) {
    console.error('Error discovering plugins:', error);
    showToast('Failed to discover plugins', 'error');
  }
}

/**
 * Render the list of plugins.
 */
export function renderPluginsList(plugins: Plugin[]): void {
  const container = getElementById<HTMLElement>('plugins-list');
  if (!container) return;

  clearElement(container);

  if (plugins.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'plugins-empty';

    // Create empty state SVG
    const svg = createSvgElement('svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');

    const rect = createSvgElement('rect');
    rect.setAttribute('x', '3');
    rect.setAttribute('y', '3');
    rect.setAttribute('width', '18');
    rect.setAttribute('height', '18');
    rect.setAttribute('rx', '2');
    rect.setAttribute('ry', '2');
    svg.appendChild(rect);

    const line1 = createSvgElement('line');
    line1.setAttribute('x1', '9');
    line1.setAttribute('y1', '9');
    line1.setAttribute('x2', '15');
    line1.setAttribute('y2', '15');
    svg.appendChild(line1);

    const line2 = createSvgElement('line');
    line2.setAttribute('x1', '15');
    line2.setAttribute('y1', '9');
    line2.setAttribute('x2', '9');
    line2.setAttribute('y2', '15');
    svg.appendChild(line2);

    emptyDiv.appendChild(svg);

    const p1 = document.createElement('p');
    p1.textContent = 'No plugins installed';
    emptyDiv.appendChild(p1);

    const p2 = document.createElement('p');
    p2.className = 'text-muted';
    p2.style.fontSize = '12px';

    const code = document.createElement('code');
    code.textContent = 'src/plugins/installed/';
    p2.textContent = 'Add plugins to the ';
    p2.appendChild(code);
    p2.appendChild(document.createTextNode(' directory'));

    emptyDiv.appendChild(p2);
    container.appendChild(emptyDiv);
    return;
  }

  // Render each plugin card
  plugins.forEach((plugin) => {
    const card = document.createElement('div');
    card.className = 'plugin-card';
    if (plugin.enabled) card.classList.add('enabled');
    if (plugin.load_error) card.classList.add('has-error');

    // Plugin icon
    const iconDiv = document.createElement('div');
    iconDiv.className = 'plugin-icon ' + plugin.plugin_type;
    iconDiv.appendChild(createPluginTypeIcon(plugin.plugin_type));
    card.appendChild(iconDiv);

    // Plugin info
    const infoDiv = document.createElement('div');
    infoDiv.className = 'plugin-info';

    // Header with name, version, badges
    const headerDiv = document.createElement('div');
    headerDiv.className = 'plugin-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'plugin-name';
    nameSpan.textContent = plugin.name;
    headerDiv.appendChild(nameSpan);

    const versionSpan = document.createElement('span');
    versionSpan.className = 'plugin-version';
    versionSpan.textContent = 'v' + plugin.version;
    headerDiv.appendChild(versionSpan);

    const typeBadge = document.createElement('span');
    typeBadge.className = 'plugin-type-badge';
    typeBadge.textContent = plugin.plugin_type;
    headerDiv.appendChild(typeBadge);

    if (plugin.is_builtin) {
      const builtinBadge = document.createElement('span');
      builtinBadge.className = 'badge badge-default';
      builtinBadge.textContent = 'Built-in';
      headerDiv.appendChild(builtinBadge);
    }

    infoDiv.appendChild(headerDiv);

    // Description
    const descDiv = document.createElement('div');
    descDiv.className = 'plugin-description';
    descDiv.textContent = plugin.description || 'No description';
    infoDiv.appendChild(descDiv);

    // Meta info
    const metaDiv = document.createElement('div');
    metaDiv.className = 'plugin-meta';
    metaDiv.textContent = 'By ' + plugin.author + ' | ' + plugin.license;
    infoDiv.appendChild(metaDiv);

    // Error message if any
    if (plugin.load_error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'plugin-error';
      errorDiv.textContent = 'Error: ' + plugin.load_error;
      infoDiv.appendChild(errorDiv);
    }

    card.appendChild(infoDiv);

    // Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'plugin-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-sm ' + (plugin.enabled ? 'btn-default' : 'btn-primary');
    toggleBtn.textContent = plugin.enabled ? 'Disable' : 'Enable';
    if (plugin.load_error && !plugin.enabled) {
      toggleBtn.disabled = true;
    }
    toggleBtn.onclick = () => togglePlugin(plugin.plugin_id, !plugin.enabled);
    actionsDiv.appendChild(toggleBtn);

    if (plugin.settings_schema && plugin.settings_schema.length > 0) {
      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'btn btn-sm btn-default';
      settingsBtn.textContent = 'Settings';
      settingsBtn.onclick = () => showPluginSettings(plugin.plugin_id);
      actionsDiv.appendChild(settingsBtn);
    }

    card.appendChild(actionsDiv);
    container.appendChild(card);
  });
}

/**
 * Toggle plugin enabled state.
 */
export async function togglePlugin(pluginId: string, enable: boolean): Promise<void> {
  try {
    await apiCall(`/api/plugins/${pluginId}/enable`, {
      method: 'POST',
      body: { enable },
    });

    showToast(enable ? 'Plugin enabled' : 'Plugin disabled', 'success');
    await loadPlugins();
    emit({ type: 'plugin:changed', reason: enable ? 'enabled' : 'disabled' });
  } catch (error) {
    console.error('Error toggling plugin:', error);
    showToast(error instanceof Error ? error.message : 'Failed to toggle plugin', 'error');
  }
}

/**
 * Show plugin settings modal.
 */
export async function showPluginSettings(pluginId: string): Promise<void> {
  try {
    const data = await apiCall<PluginSettingsResponse>(`/api/plugins/${pluginId}/settings`);

    // Build form content
    const form = document.createElement('form');
    form.id = 'plugin-settings-form';
    form.onsubmit = (e) => savePluginSettings(e, pluginId);

    data.schema.forEach((setting) => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';

      const label = document.createElement('label');
      label.setAttribute('for', 'plugin-' + setting.key);
      label.textContent = setting.label;
      formGroup.appendChild(label);

      const value = data.settings[setting.key] ?? setting.default;

      if (setting.type === 'select' && setting.options) {
        const select = document.createElement('select');
        select.id = 'plugin-' + setting.key;
        select.name = setting.key;

        setting.options.forEach((opt) => {
          const option = document.createElement('option');
          option.value = opt;
          option.textContent = opt;
          if (value === opt) option.selected = true;
          select.appendChild(option);
        });

        formGroup.appendChild(select);
      } else if (setting.type === 'boolean') {
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle-switch';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'plugin-' + setting.key;
        input.name = setting.key;
        if (value) input.checked = true;
        toggleLabel.appendChild(input);

        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggleLabel.appendChild(slider);

        formGroup.appendChild(toggleLabel);
      } else if (setting.type === 'number') {
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'plugin-' + setting.key;
        input.name = setting.key;
        input.value = String(value ?? '');
        formGroup.appendChild(input);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'plugin-' + setting.key;
        input.name = setting.key;
        input.value = String(value ?? '');
        formGroup.appendChild(input);
      }

      if (setting.description) {
        const help = document.createElement('small');
        help.className = 'form-help';
        help.textContent = setting.description;
        formGroup.appendChild(help);
      }

      form.appendChild(formGroup);
    });

    // Footer with buttons
    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-default';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeModal;
    footer.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save Settings';
    footer.appendChild(saveBtn);

    form.appendChild(footer);

    createDynamicModal({
      title: 'Plugin Settings',
      content: form,
      showFooter: false, // Form has its own buttons
    });
  } catch (error) {
    console.error('Error loading plugin settings:', error);
    showToast('Failed to load plugin settings', 'error');
  }
}

/**
 * Save plugin settings.
 */
export async function savePluginSettings(event: Event, pluginId: string): Promise<void> {
  event.preventDefault();

  const form = event.target as HTMLFormElement;
  const settings: Record<string, string | number | boolean> = {};

  const plugin = availablePlugins.find((p) => p.plugin_id === pluginId);
  if (plugin?.settings_schema) {
    plugin.settings_schema.forEach((setting) => {
      const input = form.querySelector(`[name="${setting.key}"]`) as
        | HTMLInputElement
        | HTMLSelectElement
        | null;
      if (input) {
        if (setting.type === 'boolean') {
          settings[setting.key] = (input as HTMLInputElement).checked;
        } else if (setting.type === 'number') {
          settings[setting.key] = parseFloat(input.value) || 0;
        } else {
          settings[setting.key] = input.value;
        }
      }
    });
  }

  try {
    await apiCall(`/api/plugins/${pluginId}/settings`, {
      method: 'PUT',
      body: { settings },
    });

    closeModal();
    showToast('Settings saved', 'success');
  } catch (error) {
    console.error('Error saving plugin settings:', error);
    showToast(error instanceof Error ? error.message : 'Failed to save settings', 'error');
  }
}

// Mutex flag to prevent concurrent loadPluginAnalysis() calls.
// Multiple calls can occur from tab switching + automatic triggers,
// causing duplicate DOM rendering.
let isLoadingPluginAnalysis = false;

/**
 * Load plugin analysis results.
 */
export async function loadPluginAnalysis(): Promise<void> {
  // Prevent concurrent calls that cause duplicate rendering
  if (isLoadingPluginAnalysis) {
    console.debug('loadPluginAnalysis already in progress, skipping');
    return;
  }
  isLoadingPluginAnalysis = true;

  const container = getElementById<HTMLElement>('plugin-insights-container');
  const loading = getElementById<HTMLElement>('plugin-insights-loading');

  setVisible(loading, true);
  if (container) clearElement(container);

  try {
    // Add cache-busting timestamp to bypass browser HTTP cache
    const timestamp = Date.now();
    const data = await apiCall<PluginAnalysisData>(`/api/analysis/plugins?_t=${timestamp}`);

    setVisible(loading, false);

    if (!container) return;

    // Clear container again in case a concurrent call populated it
    // between our initial clear and the await completing
    clearElement(container);

    if (!data.plugins || data.plugins.length === 0) {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = 'No analysis plugins available.';
      container.appendChild(p);
      return;
    }

    // Deduplicate plugins - API may return duplicates due to race conditions
    // or registry state; track what we've rendered to avoid duplicate DOM nodes.
    const renderedPlugins = new Set<string>();

    data.plugins.forEach((plugin) => {
      if (renderedPlugins.has(plugin.plugin_name)) {
        console.warn(`Skipping duplicate plugin: ${plugin.plugin_name}`);
        return;
      }
      renderedPlugins.add(plugin.plugin_name);
      const resultDiv = document.createElement('div');
      resultDiv.className = 'plugin-result';

      const title = document.createElement('h4');
      title.textContent = plugin.plugin_name;
      resultDiv.appendChild(title);

      // Show key metrics
      if (plugin.metrics) {
        const metricsDiv = document.createElement('div');
        metricsDiv.className = 'plugin-metrics';

        // Tax-Loss Harvester metrics
        if (plugin.metrics.total_unrealized_losses !== undefined) {
          addMetricItem(
            metricsDiv,
            formatNumber(plugin.metrics.total_unrealized_losses),
            'Unrealized Losses',
            'negative',
            true
          );
          addMetricItem(
            metricsDiv,
            formatNumber(plugin.metrics.estimated_tax_savings),
            'Est. Tax Savings',
            'positive',
            true
          );
          addMetricItem(
            metricsDiv,
            String(plugin.metrics.harvesting_opportunities),
            'Opportunities',
            ''
          );
        }

        // Dividend Tracker metrics
        if (plugin.metrics.estimated_annual_income !== undefined) {
          addMetricItem(
            metricsDiv,
            formatNumber(plugin.metrics.estimated_annual_income),
            'Est. Annual Dividends',
            'positive',
            true
          );
          addMetricItem(
            metricsDiv,
            (plugin.metrics.portfolio_yield ?? 0).toFixed(2) + '%',
            'Portfolio Yield',
            ''
          );
          addMetricItem(
            metricsDiv,
            formatNumber(plugin.metrics.monthly_income_estimate || 0),
            'Monthly Income',
            '',
            true
          );
        }

        resultDiv.appendChild(metricsDiv);
      }

      // Show insights
      if (plugin.insights && plugin.insights.length > 0) {
        const insightsDiv = document.createElement('div');
        insightsDiv.className = 'plugin-insights-list';

        plugin.insights.forEach((insight) => {
          const p = document.createElement('p');
          p.className = 'insight-item';
          p.textContent = insight;
          insightsDiv.appendChild(p);
        });

        resultDiv.appendChild(insightsDiv);
      }

      container.appendChild(resultDiv);
    });
  } catch (error) {
    console.error('Error loading plugin analysis:', error);
    setVisible(loading, false);
    if (container) {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent =
        'Failed to load analysis. ' + (error instanceof Error ? error.message : 'Unknown error');
      container.appendChild(p);
    }
  } finally {
    isLoadingPluginAnalysis = false;
  }
}

/**
 * Helper to add a metric item.
 */
function addMetricItem(
  container: HTMLElement,
  value: string,
  label: string,
  cssClass: string,
  withDollar = false
): void {
  const item = document.createElement('div');
  item.className = 'metric-item';

  const valueSpan = document.createElement('span');
  valueSpan.className = 'metric-value' + (cssClass ? ' ' + cssClass : '');
  valueSpan.textContent = withDollar ? '$' + value : value;
  item.appendChild(valueSpan);

  const labelSpan = document.createElement('span');
  labelSpan.className = 'metric-label';
  labelSpan.textContent = label;
  item.appendChild(labelSpan);

  container.appendChild(item);
}

/**
 * Properly clean up Plotly chart instances before clearing a container.
 * Plotly maintains internal state tied to DOM elements; calling purge()
 * releases these resources and prevents memory leaks or rendering artifacts.
 */
function purgeChartsInContainer(container: HTMLElement): void {
  const chartDivs = container.querySelectorAll('[class*="plotly"], [class*="js-plotly"]');
  chartDivs.forEach((div) => {
    try {
      // Plotly is loaded globally via CDN
      const Plotly = (window as unknown as { Plotly?: { purge: (el: Element) => void } }).Plotly;
      if (Plotly?.purge) {
        Plotly.purge(div);
      }
    } catch (e) {
      // Log but continue - Plotly may not be loaded yet, which is expected on first render
      console.debug('Failed to purge Plotly chart (may be expected if Plotly not loaded):', e);
    }
  });
}

// Mutex flag to prevent concurrent loadWidgets() calls
let isLoadingWidgets = false;

/**
 * Load widget dashboard.
 */
export async function loadWidgets(): Promise<void> {
  // Prevent concurrent calls that cause duplicate rendering
  if (isLoadingWidgets) {
    console.debug('loadWidgets already in progress, skipping');
    return;
  }
  isLoadingWidgets = true;

  const container = getElementById<HTMLElement>('widget-grid');
  const loading = getElementById<HTMLElement>('widget-loading');

  setVisible(loading, true);

  // Purge any existing Plotly charts before clearing to release resources
  if (container) {
    purgeChartsInContainer(container);
    clearElement(container);
  }

  try {
    // Add cache-busting timestamp to bypass browser HTTP cache
    const timestamp = Date.now();
    const data = await apiCall<{ widgets: WidgetData[] }>(`/api/analysis/widgets?_t=${timestamp}`);

    setVisible(loading, false);

    if (!container) return;

    if (!data.widgets || data.widgets.length === 0) {
      setStateView(container, {
        kind: 'empty',
        title: 'No widget plugins available',
        description:
          'Install or enable widget plugins from the Plugins tab to see custom dashboard insights here.',
      });
      return;
    }

    // Render each widget
    data.widgets.forEach((widget) => {
      const widgetItem = document.createElement('div');

      if (!widget.success) {
        widgetItem.className = 'widget-item widget-error';

        const header = document.createElement('div');
        header.className = 'widget-header';
        const title = document.createElement('h4');
        title.textContent = widget.plugin_name;
        header.appendChild(title);
        widgetItem.appendChild(header);

        const body = document.createElement('div');
        body.className = 'widget-body';
        const errorP = document.createElement('p');
        errorP.className = 'text-muted';
        errorP.textContent = 'Error: ' + (widget.error || 'Unknown error');
        body.appendChild(errorP);
        widgetItem.appendChild(body);

        container.appendChild(widgetItem);
        return;
      }

      const config = widget.config || {};
      const content = widget.content || {};

      widgetItem.className = 'widget-item';
      widgetItem.classList.add('widget-w' + (config.default_width || 1));
      widgetItem.classList.add('widget-h' + (config.default_height || 1));

      const header = document.createElement('div');
      header.className = 'widget-header';
      const title = document.createElement('h4');
      title.textContent = config.title || widget.plugin_name;
      header.appendChild(title);
      widgetItem.appendChild(header);

      const body = document.createElement('div');
      body.className = 'widget-body';

      if (content.html) {
        // Widget HTML is generated by trusted backend plugins, not user input.
        // This is analogous to markdown rendering in analysis.ts.
        // eslint-disable-next-line no-unsanitized/property
        body.innerHTML = content.html;

        // Execute scripts that were added via innerHTML.
        // Browsers don't auto-execute script tags inserted via innerHTML for security.
        // We explicitly re-execute them here because widget HTML comes from our
        // trusted backend plugins, not user input.
        const scripts = body.querySelectorAll('script');
        scripts.forEach((oldScript) => {
          try {
            const newScript = document.createElement('script');
            Array.from(oldScript.attributes).forEach((attr) => {
              newScript.setAttribute(attr.name, attr.value);
            });
            newScript.textContent = oldScript.textContent;
            oldScript.parentNode?.replaceChild(newScript, oldScript);
          } catch (e) {
            console.error(`Failed to execute widget script for ${widget.plugin_name}:`, e);
          }
        });
      } else {
        const emptyP = document.createElement('p');
        emptyP.className = 'text-muted';
        emptyP.textContent = 'No content to display.';
        body.appendChild(emptyP);
      }

      widgetItem.appendChild(body);
      container.appendChild(widgetItem);
    });
  } catch (error) {
    console.error('Error loading widgets:', error);
    setVisible(loading, false);
    if (container) {
      setStateView(container, {
        kind: 'error',
        title: 'Could not load widgets',
        description: error instanceof Error ? error.message : 'Unknown error.',
        action: {
          label: 'Retry',
          onClick: () => {
            loadWidgets().catch((err) => console.error('Widget retry failed:', err));
          },
        },
      });
    }
  } finally {
    isLoadingWidgets = false;
  }
}

/**
 * Load plugin security information.
 */
export async function loadPluginSecurity(): Promise<void> {
  const container = getElementById<HTMLElement>('plugin-security-container');
  const auditContainer = getElementById<HTMLElement>('security-audit-container');

  if (container) {
    container.textContent = '';
    const loadingP = document.createElement('p');
    loadingP.className = 'text-muted';
    loadingP.textContent = 'Loading...';
    container.appendChild(loadingP);
  }

  try {
    // Load permissions
    const permData = await apiCall<PluginPermissions>('/api/plugins/security/permissions');

    // Load audit log
    let auditData: AuditLogResponse = { entries: [] };
    try {
      auditData = await apiCall<AuditLogResponse>('/api/plugins/security/audit?limit=20');
    } catch {
      // Audit log might not be available
    }

    if (!container) return;

    clearElement(container);

    // Show pending warning
    if (permData.pending_count > 0) {
      const alert = document.createElement('div');
      alert.className = 'alert alert-warning';
      alert.style.marginBottom = '15px';

      const strong = document.createElement('strong');
      strong.textContent = permData.pending_count + ' plugin(s)';
      alert.appendChild(strong);
      alert.appendChild(
        document.createTextNode(' require permission approval before they can be loaded.')
      );
      container.appendChild(alert);
    }

    // Build permissions table
    const table = document.createElement('table');
    table.className = 'data-table compact-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Plugin', 'Type', 'Permissions', 'Status', 'Actions'].forEach((text) => {
      const th = document.createElement('th');
      th.textContent = text;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    permData.plugins.forEach((plugin) => {
      const tr = document.createElement('tr');

      // Name
      const nameTd = document.createElement('td');
      nameTd.textContent = plugin.name;
      tr.appendChild(nameTd);

      // Type
      const typeTd = document.createElement('td');
      typeTd.textContent = plugin.is_builtin ? 'Built-in' : 'Installed';
      tr.appendChild(typeTd);

      // Permissions
      const permTd = document.createElement('td');
      const perms: string[] = [];
      if (plugin.requested.file_read) perms.push('file_read');
      if (plugin.requested.file_write) {
        const span = document.createElement('span');
        span.className = 'text-warning';
        span.textContent = 'file_write';
        perms.push(span.outerHTML);
      }
      if (plugin.requested.network) {
        const span = document.createElement('span');
        span.className = 'text-warning';
        span.textContent = 'network';
        perms.push(span.outerHTML);
      }
      if (plugin.requested.database !== 'none') {
        perms.push('db:' + plugin.requested.database);
      }
      permTd.textContent = perms.length > 0 ? perms.join(', ') : 'None';
      tr.appendChild(permTd);

      // Status
      const statusTd = document.createElement('td');
      const badge = document.createElement('span');

      if (plugin.is_builtin) {
        badge.className = 'badge badge-success';
        badge.textContent = 'Built-in';
      } else if (plugin.approved) {
        badge.className = 'badge badge-success';
        badge.textContent = 'Approved';
      } else if (plugin.needs_approval) {
        badge.className = 'badge badge-warning';
        badge.textContent = 'Pending';
      } else {
        badge.className = 'badge badge-default';
        badge.textContent = 'No sensitive perms';
      }
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);

      // Actions
      const actionsTd = document.createElement('td');

      if (plugin.is_builtin) {
        const dash = document.createElement('span');
        dash.className = 'text-muted';
        dash.textContent = '-';
        actionsTd.appendChild(dash);
      } else if (plugin.approved) {
        const revokeBtn = document.createElement('button');
        revokeBtn.className = 'btn btn-xs btn-danger';
        revokeBtn.textContent = 'Revoke';
        revokeBtn.onclick = () => revokePluginPermissions(plugin.plugin_id);
        actionsTd.appendChild(revokeBtn);
      } else if (plugin.needs_approval) {
        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn btn-xs btn-primary';
        approveBtn.textContent = 'Approve';
        approveBtn.onclick = () => approvePluginPermissions(plugin.plugin_id, true);
        actionsTd.appendChild(approveBtn);

        actionsTd.appendChild(document.createTextNode(' '));

        const denyBtn = document.createElement('button');
        denyBtn.className = 'btn btn-xs btn-danger';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => approvePluginPermissions(plugin.plugin_id, false);
        actionsTd.appendChild(denyBtn);
      } else {
        const dash = document.createElement('span');
        dash.className = 'text-muted';
        dash.textContent = '-';
        actionsTd.appendChild(dash);
      }

      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);

    // Render audit log
    if (auditContainer) {
      clearElement(auditContainer);

      if (auditData.entries && auditData.entries.length > 0) {
        const logDiv = document.createElement('div');
        logDiv.className = 'audit-log';

        auditData.entries.slice(0, 10).forEach((entry) => {
          const entryDiv = document.createElement('div');
          entryDiv.className = 'audit-entry ' + (entry.success ? 'audit-success' : 'audit-failure');

          const icon = document.createElement('span');
          icon.className = 'audit-icon';
          icon.textContent = entry.success ? '✓' : '✗';
          entryDiv.appendChild(icon);

          const time = document.createElement('span');
          time.className = 'audit-time';
          time.textContent = new Date(entry.timestamp).toLocaleString();
          entryDiv.appendChild(time);

          const eventType = document.createElement('span');
          eventType.className = 'audit-event';
          eventType.textContent = entry.event_type;
          entryDiv.appendChild(eventType);

          const pluginId = document.createElement('span');
          pluginId.className = 'audit-plugin';
          pluginId.textContent = entry.plugin_id;
          entryDiv.appendChild(pluginId);

          logDiv.appendChild(entryDiv);
        });

        auditContainer.appendChild(logDiv);
      } else {
        const p = document.createElement('p');
        p.className = 'text-muted';
        p.textContent = 'No security events recorded.';
        auditContainer.appendChild(p);
      }
    }
  } catch (error) {
    console.error('Error loading plugin security:', error);
    if (container) {
      clearElement(container);
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent =
        'Failed to load plugin security. ' +
        (error instanceof Error ? error.message : 'Unknown error');
      container.appendChild(p);
    }
  }
}

/**
 * Approve or deny plugin permissions.
 */
export async function approvePluginPermissions(pluginId: string, approve: boolean): Promise<void> {
  try {
    await apiCall(`/api/plugins/security/permissions/${pluginId}/approve`, {
      method: 'POST',
      body: { approve },
    });

    showToast(approve ? 'Permissions approved' : 'Permissions denied', 'success');
    await loadPluginSecurity();
  } catch (error) {
    showToast('Error: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}

/**
 * Revoke plugin permissions.
 */
export async function revokePluginPermissions(pluginId: string): Promise<void> {
  if (
    !confirm('Revoke permissions for this plugin? It will be disabled and require re-approval.')
  ) {
    return;
  }

  try {
    await apiCall(`/api/plugins/security/permissions/${pluginId}/revoke`, {
      method: 'POST',
    });

    showToast('Permissions revoked', 'success');
    await loadPluginSecurity();
  } catch (error) {
    showToast('Error: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}

/**
 * Load installed plugins list.
 */
export async function loadInstalledPlugins(): Promise<void> {
  const container = getElementById<HTMLElement>('installed-plugins-container');
  if (!container) return;

  try {
    const data = await apiCall<{ count: number; plugins: Plugin[] }>('/api/plugins/installed');

    clearElement(container);

    if (data.count === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';

      const p1 = document.createElement('p');
      p1.className = 'text-muted';
      p1.textContent = 'No third-party plugins installed.';
      emptyDiv.appendChild(p1);

      const p2 = document.createElement('p');
      p2.className = 'text-muted';
      p2.textContent = 'Click "Install Plugin" to add plugins from Git or upload a ZIP file.';
      emptyDiv.appendChild(p2);

      container.appendChild(emptyDiv);
      return;
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'installed-plugins-list';

    data.plugins.forEach((plugin) => {
      const card = document.createElement('div');
      card.className = 'installed-plugin-card';
      card.dataset.pluginId = plugin.plugin_id;

      // Plugin info
      const infoDiv = document.createElement('div');
      infoDiv.className = 'plugin-info';

      // Header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'plugin-header';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'plugin-name';
      nameSpan.textContent = plugin.name;
      headerDiv.appendChild(nameSpan);

      const versionSpan = document.createElement('span');
      versionSpan.className = 'plugin-version';
      versionSpan.textContent = 'v' + plugin.version;
      headerDiv.appendChild(versionSpan);

      const typeBadge = document.createElement('span');
      typeBadge.className =
        'plugin-type badge badge-' + getPluginTypeBadgeClass(plugin.plugin_type);
      typeBadge.textContent = plugin.plugin_type;
      headerDiv.appendChild(typeBadge);

      infoDiv.appendChild(headerDiv);

      // Description
      const descP = document.createElement('p');
      descP.className = 'plugin-description';
      descP.textContent = plugin.description || 'No description';
      infoDiv.appendChild(descP);

      // Meta
      const metaDiv = document.createElement('div');
      metaDiv.className = 'plugin-meta';

      const authorSpan = document.createElement('span');
      authorSpan.className = 'plugin-author';
      authorSpan.textContent = 'By ' + (plugin.author || 'Unknown');
      metaDiv.appendChild(authorSpan);

      if (plugin.source) {
        const sourceSpan = document.createElement('span');
        sourceSpan.className = 'plugin-source';

        const sourceIcon = createSvgElement('svg');
        sourceIcon.setAttribute('viewBox', '0 0 24 24');
        sourceIcon.setAttribute('width', '12');
        sourceIcon.setAttribute('height', '12');
        sourceIcon.setAttribute('fill', 'none');
        sourceIcon.setAttribute('stroke', 'currentColor');
        sourceIcon.setAttribute('stroke-width', '2');

        if (plugin.source.type === 'git') {
          // Globe icon
          const circle = createSvgElement('circle');
          circle.setAttribute('cx', '12');
          circle.setAttribute('cy', '12');
          circle.setAttribute('r', '10');
          sourceIcon.appendChild(circle);
          const line = createSvgElement('line');
          line.setAttribute('x1', '2');
          line.setAttribute('y1', '12');
          line.setAttribute('x2', '22');
          line.setAttribute('y2', '12');
          sourceIcon.appendChild(line);
          const path = createSvgElement('path');
          path.setAttribute(
            'd',
            'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'
          );
          sourceIcon.appendChild(path);
        } else {
          // File icon
          const rect = createSvgElement('rect');
          rect.setAttribute('x', '2');
          rect.setAttribute('y', '4');
          rect.setAttribute('width', '20');
          rect.setAttribute('height', '16');
          rect.setAttribute('rx', '2');
          sourceIcon.appendChild(rect);
        }

        sourceSpan.appendChild(sourceIcon);
        sourceSpan.appendChild(
          document.createTextNode(' ' + (plugin.source.url || plugin.source.type))
        );
        metaDiv.appendChild(sourceSpan);
      }

      infoDiv.appendChild(metaDiv);
      card.appendChild(infoDiv);

      // Actions
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'plugin-actions';

      if (plugin.source?.type === 'git') {
        const updateBtn = document.createElement('button');
        updateBtn.className = 'btn btn-sm btn-default';
        updateBtn.title = 'Check for updates';
        updateBtn.onclick = () => checkPluginUpdate(plugin.plugin_id);

        // Refresh icon
        const refreshIcon = createSvgElement('svg');
        refreshIcon.setAttribute('viewBox', '0 0 24 24');
        refreshIcon.setAttribute('width', '14');
        refreshIcon.setAttribute('height', '14');
        refreshIcon.setAttribute('fill', 'none');
        refreshIcon.setAttribute('stroke', 'currentColor');
        refreshIcon.setAttribute('stroke-width', '2');

        const polyline = createSvgElement('polyline');
        polyline.setAttribute('points', '23 4 23 10 17 10');
        refreshIcon.appendChild(polyline);

        const path = createSvgElement('path');
        path.setAttribute('d', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
        refreshIcon.appendChild(path);

        updateBtn.appendChild(refreshIcon);
        actionsDiv.appendChild(updateBtn);
      }

      const uninstallBtn = document.createElement('button');
      uninstallBtn.className = 'btn btn-sm btn-danger';
      uninstallBtn.title = 'Uninstall plugin';
      uninstallBtn.onclick = () => uninstallPlugin(plugin.plugin_id);

      // Trash icon
      const trashIcon = createSvgElement('svg');
      trashIcon.setAttribute('viewBox', '0 0 24 24');
      trashIcon.setAttribute('width', '14');
      trashIcon.setAttribute('height', '14');
      trashIcon.setAttribute('fill', 'none');
      trashIcon.setAttribute('stroke', 'currentColor');
      trashIcon.setAttribute('stroke-width', '2');

      const polyline = createSvgElement('polyline');
      polyline.setAttribute('points', '3 6 5 6 21 6');
      trashIcon.appendChild(polyline);

      const trashPath = createSvgElement('path');
      trashPath.setAttribute(
        'd',
        'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
      );
      trashIcon.appendChild(trashPath);

      uninstallBtn.appendChild(trashIcon);
      actionsDiv.appendChild(uninstallBtn);

      card.appendChild(actionsDiv);
      listDiv.appendChild(card);
    });

    container.appendChild(listDiv);
  } catch (error) {
    console.error('Error loading installed plugins:', error);
    clearElement(container);
    const p = document.createElement('p');
    p.className = 'text-muted';
    p.textContent =
      'Failed to load installed plugins. ' +
      (error instanceof Error ? error.message : 'Unknown error');
    container.appendChild(p);
  }
}

/**
 * Get badge class for plugin type.
 */
export function getPluginTypeBadgeClass(pluginType: string): string {
  const classes: Record<string, string> = {
    importer: 'info',
    analysis: 'success',
    widget: 'warning',
    provider: 'primary',
    export: 'secondary',
  };
  return classes[pluginType] || 'default';
}

/**
 * Show install plugin modal.
 */
export function showInstallPluginModal(): void {
  const modal = getElementById<HTMLElement>('install-plugin-modal');
  const gitInput = getElementById<HTMLInputElement>('git-source');
  const fileInput = getElementById<HTMLInputElement>('plugin-file');
  const fileName = getElementById<HTMLElement>('upload-file-name');

  if (modal) {
    // `hidden` is `display:none !important`; strip it so the modal shows.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
  if (gitInput) gitInput.value = '';
  if (fileInput) fileInput.value = '';
  if (fileName) fileName.textContent = 'Drag and drop or click to select a ZIP file';

  switchInstallTab('git');
}

/**
 * Hide install plugin modal.
 */
export function hideInstallPluginModal(): void {
  const modal = getElementById<HTMLElement>('install-plugin-modal');
  if (modal) modal.style.display = 'none';
}

/**
 * Switch between install tabs.
 */
export function switchInstallTab(tabName: string): void {
  // Update tab buttons
  document.querySelectorAll('.install-tab').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('.install-tab-content').forEach((content) => {
    (content as HTMLElement).style.display =
      content.id === `install-tab-${tabName}` ? 'block' : 'none';
  });
}

/**
 * Install plugin from Git repository.
 */
export async function installFromGit(event: Event): Promise<void> {
  event.preventDefault();

  if (store.get('dataMode') === 'local') {
    showToast('Plugins are disabled in hosted mode.', 'info');
    return;
  }

  const sourceInput = getElementById<HTMLInputElement>('git-source');
  const source = sourceInput?.value.trim();

  if (!source) {
    showToast('Please enter a repository source', 'error');
    return;
  }

  const btn = getElementById<HTMLButtonElement>('git-install-btn');
  const btnText = btn?.querySelector('.btn-text') as HTMLElement | null;
  const btnLoading = btn?.querySelector('.btn-loading') as HTMLElement | null;

  // Show loading state
  if (btn) btn.disabled = true;
  setVisible(btnText, false);
  setVisible(btnLoading, true, 'inline-flex');

  try {
    // Need signature headers for this endpoint
    let signatureHeaders: Record<string, string> = {};
    if (isSigningRequired()) {
      signatureHeaders = await generateSignatureHeaders('POST', '/api/plugins/install/git');
    }

    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/api/plugins/install/git`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signatureHeaders },
      credentials: 'include',
      body: JSON.stringify({ source }),
    });

    const data: InstallResponse = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || data.errors?.join(', ') || 'Installation failed');
    }

    showToast(`Successfully installed ${data.plugin_name} v${data.version}`, 'success');
    hideInstallPluginModal();
    await loadInstalledPlugins();
    await loadPluginSecurity();
    emit({ type: 'plugin:changed', reason: 'installed' });
  } catch (error) {
    showToast(
      'Installation failed: ' + (error instanceof Error ? error.message : 'Unknown error'),
      'error'
    );
  } finally {
    if (btn) btn.disabled = false;
    setVisible(btnText, true);
    setVisible(btnLoading, false);
  }
}

/**
 * Handle plugin file selection.
 */
export function handlePluginFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const nameDisplay = getElementById<HTMLElement>('upload-file-name');

  if (nameDisplay) {
    nameDisplay.textContent = file?.name || 'Drag and drop or click to select a ZIP file';
  }
}

/**
 * Install plugin from uploaded file.
 */
export async function installFromUpload(event: Event): Promise<void> {
  event.preventDefault();

  if (store.get('dataMode') === 'local') {
    showToast('Plugins are disabled in hosted mode.', 'info');
    return;
  }

  const fileInput = getElementById<HTMLInputElement>('plugin-file');
  const file = fileInput?.files?.[0];

  if (!file) {
    showToast('Please select a ZIP file', 'error');
    return;
  }

  const btn = getElementById<HTMLButtonElement>('upload-install-btn');
  const btnText = btn?.querySelector('.btn-text') as HTMLElement | null;
  const btnLoading = btn?.querySelector('.btn-loading') as HTMLElement | null;

  // Show loading state
  if (btn) btn.disabled = true;
  setVisible(btnText, false);
  setVisible(btnLoading, true, 'inline-flex');

  try {
    const data = await uploadFile<InstallResponse>('/api/plugins/install/upload', file);

    if (!data.success) {
      throw new Error(data.message || data.errors?.join(', ') || 'Installation failed');
    }

    showToast(`Successfully installed ${data.plugin_name} v${data.version}`, 'success');
    hideInstallPluginModal();
    await loadInstalledPlugins();
    await loadPluginSecurity();
    emit({ type: 'plugin:changed', reason: 'installed' });
  } catch (error) {
    showToast(
      'Installation failed: ' + (error instanceof Error ? error.message : 'Unknown error'),
      'error'
    );
  } finally {
    if (btn) btn.disabled = false;
    setVisible(btnText, true);
    setVisible(btnLoading, false);
  }
}

/**
 * Uninstall a plugin.
 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  if (!confirm('Are you sure you want to uninstall this plugin? This cannot be undone.')) {
    return;
  }

  try {
    await apiCall<InstallResponse>(`/api/plugins/installed/${pluginId}`, {
      method: 'DELETE',
    });

    showToast('Plugin uninstalled successfully', 'success');
    await loadInstalledPlugins();
    await loadPluginSecurity();
    emit({ type: 'plugin:changed', reason: 'uninstalled' });
  } catch (error) {
    showToast('Error: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}

/**
 * Check for plugin update.
 */
export async function checkPluginUpdate(pluginId: string): Promise<void> {
  try {
    const data = await apiCall<UpdateCheckResponse>(`/api/plugins/installed/${pluginId}/updates`);

    if (data.has_update) {
      if (
        confirm(
          `Update available: ${data.current_commit} → ${data.latest_commit}\n\nWould you like to update now?`
        )
      ) {
        await updatePlugin(pluginId);
      }
    } else {
      showToast('Plugin is up to date', 'info');
    }
  } catch (error) {
    showToast(
      'Error checking for updates: ' + (error instanceof Error ? error.message : 'Unknown error'),
      'error'
    );
  }
}

/**
 * Update a plugin.
 */
export async function updatePlugin(pluginId: string): Promise<void> {
  try {
    const data = await apiCall<InstallResponse>(`/api/plugins/installed/${pluginId}/update`, {
      method: 'POST',
    });

    if (!data.success) {
      throw new Error(data.message || 'Update failed');
    }

    showToast(`Successfully updated ${data.plugin_name} to v${data.version}`, 'success');
    await loadInstalledPlugins();
    await loadPluginSecurity();
  } catch (error) {
    showToast(
      'Error updating plugin: ' + (error instanceof Error ? error.message : 'Unknown error'),
      'error'
    );
  }
}

/**
 * Check all plugins for updates.
 */
export async function checkPluginUpdates(): Promise<void> {
  const banner = getElementById<HTMLElement>('updates-available-banner');
  const countEl = getElementById<HTMLElement>('updates-count');
  const messageEl = getElementById<HTMLElement>('updates-message');

  try {
    showToast('Checking for updates...', 'info');

    const data = await apiCall<BulkUpdateCheckResponse>('/api/plugins/installed/check-updates', {
      method: 'POST',
    });

    if (data.count > 0) {
      if (banner) banner.style.display = 'flex';
      if (countEl)
        countEl.textContent = `${data.count} Update${data.count > 1 ? 's' : ''} Available`;
      if (messageEl)
        messageEl.textContent = data.updates_available.map((u) => u.plugin_id).join(', ');
      showToast(`${data.count} plugin update(s) available`, 'info');
    } else {
      if (banner) banner.style.display = 'none';
      showToast('All plugins are up to date', 'success');
    }
  } catch (error) {
    showToast(
      'Error checking for updates: ' + (error instanceof Error ? error.message : 'Unknown error'),
      'error'
    );
  }
}

/**
 * Initialize the plugins system.
 */
export function initPlugins(): void {
  // Set up install tab switching
  document.querySelectorAll('.install-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabName = (btn as HTMLElement).dataset.tab;
      if (tabName) switchInstallTab(tabName);
    });
  });

  // Set up file input handler
  const fileInput = getElementById<HTMLInputElement>('plugin-file');
  if (fileInput) {
    fileInput.addEventListener('change', handlePluginFileSelect);
  }

  // Git/upload install forms use the inline onsubmit="" handler in
  // index.html — do not also bind here, or the submit fires twice.

  console.debug('Plugins system initialized');
}
