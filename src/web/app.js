// Investment Portfolio Dashboard JavaScript

const API_BASE = '';
let currentPositions = [];
let currentSort = { field: 'value', direction: 'desc' };
let selectedAccounts = new Set();
let currentViewId = localStorage.getItem('portfolioViewId') || null;
let availableViews = [];
let fullHistoryData = [];
let currentHistoryDays = 30;

// Session management for multi-user mode
let sessionHmacKey = null;
let sessionSigningRequired = false;

// Utility functions
function formatCurrency(value) {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPrice(value, ticker = null) {
  // SGOV and certain securities use 3 decimal places for pricing
  if (value === null || value === undefined) return '-';
  const decimals = ticker && ticker.toUpperCase() === 'SGOV' ? 3 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatShares(value) {
  // Shares/quantity should display up to 4 decimal places
  if (value === null || value === undefined) return '-';
  // Remove trailing zeros but keep up to 4 decimal places
  const formatted = value.toFixed(4);
  return parseFloat(formatted).toString();
}

function formatPercent(value) {
  if (value === null || value === undefined) return '-';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined) return '-';
  return value.toFixed(decimals);
}

// =========================================================================
// SESSION MANAGEMENT FUNCTIONS
// =========================================================================

/**
 * Initialize session for multi-user mode.
 * Gets HMAC key for request signing if required by server.
 */
async function initSession() {
  try {
    const response = await fetch(`${API_BASE}/api/session/init`, {
      credentials: 'include',
    });
    if (response.ok) {
      const data = await response.json();
      sessionHmacKey = data.hmac_key;
      sessionSigningRequired = data.signing_required || false;
      console.log(
        `Session initialized: signing ${sessionSigningRequired ? 'required' : 'not required'}`
      );
    }
  } catch (error) {
    // Session init is optional - local mode doesn't require it
    console.log('Session init skipped (local mode)');
  }
}

/**
 * Compute HMAC-SHA256 signature using Web Crypto API.
 */
async function computeHmac(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute SHA-256 hash of a string using Web Crypto API.
 */
async function computeSha256Hash(data) {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate signature headers for mutating requests.
 * @param {string} method - HTTP method (POST, PUT, DELETE, PATCH)
 * @param {string} endpoint - API endpoint path
 * @param {string} body - Request body (JSON string or empty string for no body)
 */
async function generateSignatureHeaders(method, endpoint, body = '') {
  if (!sessionHmacKey) return {};

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const bodyHash = body ? await computeSha256Hash(body) : '';
  // Strip query parameters from endpoint to match backend request.url.path
  const cleanEndpoint = endpoint.split('?')[0];
  const message = `${timestamp}:${nonce}:${method}:${cleanEndpoint}:${bodyHash}`;
  const signature = await computeHmac(sessionHmacKey, message);

  const headers = {
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
  };

  // Include body hash header if we have a body
  if (bodyHash) {
    headers['X-Request-Body-Hash'] = bodyHash;
  }

  return headers;
}

// Welcome page functions
function isFirstVisit() {
  return !localStorage.getItem('hasVisitedBefore');
}

function completeWelcome() {
  localStorage.setItem('hasVisitedBefore', 'true');
  showTab('dashboard');
}

async function startDemoMode() {
  // Enable demo mode and go to dashboard
  try {
    await apiCall('/api/settings/demo-mode', {
      method: 'PUT',
      body: { enabled: true },
    });
    localStorage.setItem('hasVisitedBefore', 'true');
    showTab('dashboard');
    // Show demo mode banner
    const banner = document.getElementById('demo-mode-banner');
    if (banner) {
      banner.style.display = 'flex';
    }
    showToast('Demo mode enabled! Explore with sample data.', 'success');
  } catch (error) {
    console.error('Failed to enable demo mode:', error);
    showToast('Failed to enable demo mode', 'error');
  }
}

// =========================================================================
// GUIDED TOUR FUNCTIONS
// =========================================================================

let currentTourStep = 0;
let selectedDbFileHandle = null;

const tourSteps = [
  {
    target: '[data-tab="holdings"]',
    icon: '📊',
    title: 'Import Your Data',
    content:
      'You might hold investments at different institutions (brokerage, company 401k, bank, etc.) and you need to see everything in one place. Import your portfolio data from CSV exports or add positions manually.',
  },
  {
    target: '[data-tab="settings"]',
    icon: '⚙️',
    title: 'Configure Your Profile',
    content:
      'Set up your age and retirement target so the simulation is more accurate. Configure your tax filing status and state to get precise projections.',
  },
  {
    target: '[data-tab="projections"]',
    icon: '🎯',
    title: 'Run Monte Carlo Simulations',
    content:
      'A Monte Carlo simulation evaluates future growth accounting for events like Black Swan events (market crashes) thousands of times, giving you a statistical view of the likelihood that your money will serve you for the rest of your life.',
  },
];

function startTour() {
  currentTourStep = 0;
  const overlay = document.getElementById('tour-overlay');
  overlay.style.display = 'block';
  showTourStep(0);

  // Add resize handler to reposition card on window resize
  window.addEventListener('resize', handleTourResize);
}

function handleTourResize() {
  const overlay = document.getElementById('tour-overlay');
  if (overlay && overlay.style.display !== 'none') {
    const step = tourSteps[currentTourStep];
    if (step) {
      const targetEl = document.querySelector(step.target);
      if (targetEl) {
        positionTourElements(targetEl);
      }
    }
  }
}

function showTourStep(stepIndex) {
  const step = tourSteps[stepIndex];
  if (!step) return;

  // Update step indicator
  document.getElementById('tour-step-indicator').textContent = `Step ${stepIndex + 1} of ${tourSteps.length}`;

  // Update content
  document.getElementById('tour-icon').textContent = step.icon;
  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-content').textContent = step.content;

  // Update button text for last step
  const nextBtn = document.getElementById('tour-next-btn');
  // Clear existing content
  while (nextBtn.firstChild) {
    nextBtn.removeChild(nextBtn.firstChild);
  }

  if (stepIndex === tourSteps.length - 1) {
    nextBtn.appendChild(document.createTextNode('Get Started '));
    const checkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    checkIcon.setAttribute('viewBox', '0 0 24 24');
    checkIcon.setAttribute('width', '16');
    checkIcon.setAttribute('height', '16');
    checkIcon.setAttribute('fill', 'none');
    checkIcon.setAttribute('stroke', 'currentColor');
    checkIcon.setAttribute('stroke-width', '2');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '20 6 9 17 4 12');
    checkIcon.appendChild(polyline);
    nextBtn.appendChild(checkIcon);
  } else {
    nextBtn.appendChild(document.createTextNode('Next '));
    const arrowIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowIcon.setAttribute('viewBox', '0 0 24 24');
    arrowIcon.setAttribute('width', '16');
    arrowIcon.setAttribute('height', '16');
    arrowIcon.setAttribute('fill', 'none');
    arrowIcon.setAttribute('stroke', 'currentColor');
    arrowIcon.setAttribute('stroke-width', '2');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '9 18 15 12 9 6');
    arrowIcon.appendChild(polyline);
    nextBtn.appendChild(arrowIcon);
  }

  // Position spotlight and card
  const targetEl = document.querySelector(step.target);
  if (targetEl) {
    positionTourElements(targetEl);
  }

  // Re-trigger animation
  const card = document.getElementById('tour-card');
  card.style.animation = 'none';
  card.offsetHeight; // Trigger reflow
  card.style.animation = 'tourBounceIn 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
}

function positionTourElements(targetEl) {
  const rect = targetEl.getBoundingClientRect();
  const spotlight = document.getElementById('tour-spotlight');
  const card = document.getElementById('tour-card');

  // Position spotlight over target
  const padding = 6;
  spotlight.style.left = rect.left - padding + 'px';
  spotlight.style.top = rect.top - padding + 'px';
  spotlight.style.width = rect.width + padding * 2 + 'px';
  spotlight.style.height = rect.height + padding * 2 + 'px';

  // Get viewport dimensions
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // Get card dimensions (need to make it visible briefly to measure)
  card.style.visibility = 'hidden';
  card.style.display = 'block';
  const cardRect = card.getBoundingClientRect();
  const cardHeight = cardRect.height;
  const cardWidth = cardRect.width;
  card.style.visibility = 'visible';

  // Check if we're on mobile (sidebar is hidden or narrow viewport)
  const isMobile = viewportWidth < 768;
  const sidebarWidth = isMobile ? 0 : 240; // var(--sidebar-width)

  if (isMobile) {
    // On mobile: center card horizontally, position in safe area
    const cardLeft = Math.max(16, (viewportWidth - cardWidth) / 2);
    card.style.left = cardLeft + 'px';

    // Position card in upper portion of screen with padding
    const topPosition = Math.min(100, viewportHeight * 0.15);
    card.style.top = topPosition + 'px';

    // Hide spotlight on mobile (sidebar not visible)
    spotlight.style.display = 'none';
  } else {
    // On desktop: position card to the right of sidebar
    spotlight.style.display = 'block';

    // Calculate ideal top position (aligned with target, slightly above)
    let idealTop = rect.top - 30;

    // Ensure card doesn't go above viewport (min 20px from top)
    const minTop = 20;

    // Ensure card doesn't go below viewport (20px padding from bottom)
    const maxTop = viewportHeight - cardHeight - 20;

    // Clamp the position within bounds
    const finalTop = Math.max(minTop, Math.min(idealTop, maxTop));

    // Position the card
    card.style.left = sidebarWidth + 30 + 'px';
    card.style.top = finalTop + 'px';
  }
}

function nextTourStep() {
  currentTourStep++;
  if (currentTourStep >= tourSteps.length) {
    endTour();
    showProfileSetup();
  } else {
    showTourStep(currentTourStep);
  }
}

function endTour() {
  const overlay = document.getElementById('tour-overlay');
  overlay.style.display = 'none';
  localStorage.setItem('tourCompleted', 'true');

  // Remove resize handler
  window.removeEventListener('resize', handleTourResize);
}

// =========================================================================
// PROFILE SETUP FUNCTIONS
// =========================================================================

function showProfileSetup() {
  const modal = document.getElementById('profile-setup-modal');
  modal.style.display = 'flex';
}

function closeProfileSetup() {
  const modal = document.getElementById('profile-setup-modal');
  modal.style.display = 'none';
  // If user cancels, still mark welcome as seen and go to dashboard
  localStorage.setItem('hasVisitedBefore', 'true');
  showTab('dashboard');
}

function selectStorageMode(mode) {
  // Update visual selection
  document.querySelectorAll('.radio-option').forEach((opt) => {
    opt.classList.remove('selected');
    if (opt.querySelector(`input[value="${mode}"]`)) {
      opt.classList.add('selected');
      opt.querySelector('input').checked = true;
    }
  });
}

async function browseExistingDatabase() {
  // Check for File System Access API support
  if (!window.showOpenFilePicker) {
    showToast(
      'Your browser does not support file selection. Please use Chrome, Edge, or another modern browser.',
      'error'
    );
    return;
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: 'SQLite Database',
          accept: { 'application/x-sqlite3': ['.db'] },
        },
      ],
      multiple: false,
    });

    selectedDbFileHandle = handle;
    const file = await handle.getFile();

    // Update UI
    const selectedFileEl = document.getElementById('selected-db-file');
    selectedFileEl.textContent = file.name;
    selectedFileEl.classList.add('has-file');

    showToast(`Selected: ${file.name}`, 'success');
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Failed to select file:', error);
      showToast('Failed to select database file', 'error');
    }
  }
}

async function createProfile() {
  const nameInput = document.getElementById('profile-name-input');
  const profileName = nameInput.value.trim() || 'My Portfolio';
  const storageMode = document.querySelector('input[name="storage-mode"]:checked').value;

  // Generate a GUID for the database
  const dbGuid = crypto.randomUUID();

  try {
    // Disable demo mode first
    try {
      await apiCall('/api/settings/demo-mode', {
        method: 'PUT',
        body: { enabled: false },
      });
    } catch (e) {
      // Demo mode might already be off, continue
    }

    // Store configuration in localStorage
    localStorage.setItem('hasVisitedBefore', 'true');
    localStorage.setItem('tourCompleted', 'true');
    localStorage.setItem('storageMode', storageMode);
    localStorage.setItem('activeProfileId', profileName.toLowerCase().replace(/\s+/g, '-'));
    localStorage.setItem('profileDbGuid', dbGuid);

    if (storageMode === 'server') {
      // Create profile on server
      try {
        await apiCall('/api/profiles', {
          method: 'POST',
          body: {
            name: profileName,
            description: 'Created during onboarding',
            db_guid: dbGuid,
          },
        });
      } catch (e) {
        // Profile might already exist
        console.log('Profile creation result:', e);
      }
    } else {
      // Local mode - initialize client database
      if (typeof ClientDatabase !== 'undefined') {
        if (selectedDbFileHandle) {
          // Use selected existing database
          const file = await selectedDbFileHandle.getFile();
          const arrayBuffer = await file.arrayBuffer();
          await ClientDatabase.loadFromArrayBuffer(arrayBuffer);
          showToast(`Loaded existing database: ${file.name}`, 'success');
        } else {
          // Create new empty database
          await ClientDatabase.createNew();
          showToast('Created new local database', 'success');
        }
      }
    }

    // Hide demo banner
    const banner = document.getElementById('demo-mode-banner');
    if (banner) {
      banner.style.display = 'none';
    }

    // Close modal and go to Settings to configure profile
    document.getElementById('profile-setup-modal').style.display = 'none';
    showTab('settings');
    showToast(`Welcome to Finlity, ${profileName}! Configure your profile settings below.`, 'success');
  } catch (error) {
    console.error('Failed to create profile:', error);
    showToast('Failed to create profile: ' + error.message, 'error');
  }
}

// Generic API call helper
async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const method = options.method || 'GET';

  // Stringify body first (needed for signature computation)
  let bodyString = '';
  if (options.body) {
    bodyString = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
  }

  // Generate signing headers for mutating requests in multi-user mode
  let sigHeaders = {};
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && sessionHmacKey) {
    sigHeaders = await generateSignatureHeaders(method, endpoint, bodyString);
  }

  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...sigHeaders,
    },
    credentials: 'include', // Send session cookie
    ...options,
    body: bodyString || undefined,
  };

  const response = await fetch(url, config);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  // Return JSON if content-type is JSON, otherwise return text
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

// Background task polling for long-running operations
async function pollForTaskResult(taskId, options = {}) {
  const {
    maxWaitMs = 300000, // 5 minutes max
    pollIntervalMs = 2000, // Poll every 2 seconds
    onProgress = null, // Callback for progress updates
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const response = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
      credentials: 'include', // Send session cookie for task isolation
    });
    if (!response.ok) {
      throw new Error(`Failed to check task status: ${response.status}`);
    }

    const task = await response.json();

    // Call progress callback if provided
    if (onProgress && typeof onProgress === 'function') {
      onProgress(task);
    }

    if (task.status === 'completed') {
      return task.result;
    }

    if (task.status === 'failed') {
      throw new Error(task.error || 'Task failed');
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error('Task timed out');
}

// Helper to run API call that may return async task
async function runAsyncApiCall(endpoint, options = {}, taskOptions = {}) {
  const method = options.method || 'GET';

  // Stringify body first (needed for signature computation)
  let bodyString = '';
  if (options.body) {
    bodyString = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
  }

  // Generate signing headers for mutating requests in multi-user mode
  let sigHeaders = {};
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && sessionHmacKey) {
    sigHeaders = await generateSignatureHeaders(method, endpoint, bodyString);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...sigHeaders,
    },
    credentials: 'include', // Send session cookie
    ...options,
    body: bodyString || undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  // Check if this is an async task response
  if (data.task_id && data.status === 'pending') {
    // Poll for the result
    return await pollForTaskResult(data.task_id, taskOptions);
  }

  // Synchronous response - return directly
  return data;
}

// Toast notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Generic Modal
function showModal(title, content) {
  const modal = document.getElementById('generic-modal');
  const titleEl = document.getElementById('generic-modal-title');
  const bodyEl = document.getElementById('generic-modal-body');

  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.innerHTML = content;
  if (modal) modal.style.display = 'flex';
}

function closeModal() {
  const modal = document.getElementById('generic-modal');
  if (modal) modal.style.display = 'none';
}

// Loading overlay with rotating messages
let loadingMessageInterval = null;
let loadingMessageIndex = 0;

const loadingMessages = {
  default: ['Loading...'],
  monteCarlo: [
    'Running Monte Carlo simulation...',
    'Simulating market scenarios...',
    'Crunching the numbers...',
    'Analyzing thousands of outcomes...',
    'Still working...',
    'Projecting your future wealth...',
    'Almost there...',
    'Running statistical analysis...',
    'Calculating probabilities...',
  ],
};

function showLoading(message = 'Loading...', rotateMessages = false) {
  const overlay = document.getElementById('loading-overlay');
  const textEl = overlay.querySelector('.loading-text');
  if (textEl) textEl.textContent = message;
  overlay.style.display = 'flex';
  // Force reflow for transition
  overlay.offsetHeight;
  overlay.classList.add('visible');

  // Clear any existing interval
  if (loadingMessageInterval) {
    clearInterval(loadingMessageInterval);
    loadingMessageInterval = null;
  }

  // Set up rotating messages if requested
  if (rotateMessages && textEl) {
    loadingMessageIndex = 0;
    const messages = loadingMessages.monteCarlo;

    loadingMessageInterval = setInterval(() => {
      loadingMessageIndex = (loadingMessageIndex + 1) % messages.length;
      textEl.textContent = messages[loadingMessageIndex];
    }, 5000);
  }
}

function hideLoading() {
  // Clear rotating messages interval
  if (loadingMessageInterval) {
    clearInterval(loadingMessageInterval);
    loadingMessageInterval = null;
  }

  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('visible');
  // Wait for transition then hide
  setTimeout(() => {
    if (!overlay.classList.contains('visible')) {
      overlay.style.display = 'none';
    }
  }, 200);
}

function updateLoadingMessage(message) {
  // Update loading message without affecting visibility
  const overlay = document.getElementById('loading-overlay');
  const textEl = overlay?.querySelector('.loading-text');
  if (textEl) {
    textEl.textContent = message;
  }
}

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  setTheme(savedTheme, false);
}

function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);

  // Update radio buttons in settings
  const radioButtons = document.querySelectorAll('input[name="theme"]');
  radioButtons.forEach((radio) => {
    radio.checked = radio.value === theme;
  });

  if (save) {
    localStorage.setItem('theme', theme);
    // Also save to server
    fetch(`${API_BASE}/api/settings/theme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: theme }),
    }).catch(console.error);
  }

  // Update Plotly charts if they exist
  updateChartTheme(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
}

// Sidebar collapse toggle
function toggleSidebarCollapse() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
  }
}

// Initialize sidebar state from localStorage
function initSidebarState() {
  const sidebar = document.querySelector('.sidebar');
  const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
  if (sidebar && isCollapsed) {
    sidebar.classList.add('collapsed');
  }

  // Bind sidebar collapse toggle button (more reliable than inline onclick)
  const collapseBtn = document.querySelector('.sidebar-collapse-toggle');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', toggleSidebarCollapse);
  }
}

// Mobile navigation toggle
function toggleMobileNav() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.mobile-nav-overlay');

  if (sidebar && overlay) {
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('active');

    // Prevent body scroll when menu is open
    if (sidebar.classList.contains('mobile-open')) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }
}

// Close mobile nav when a nav item is clicked
function closeMobileNav() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.mobile-nav-overlay');

  if (sidebar && overlay) {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// Initialize mobile nav - close on nav item click
function initMobileNav() {
  const navItems = document.querySelectorAll('.sidebar .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', closeMobileNav);
  });
}

function updateChartTheme(theme) {
  const isDark = theme === 'dark';
  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
    xaxis: {
      gridcolor: isDark ? '#303030' : '#f0f0f0',
      zerolinecolor: isDark ? '#424242' : '#d9d9d9',
    },
    yaxis: {
      gridcolor: isDark ? '#303030' : '#f0f0f0',
      zerolinecolor: isDark ? '#424242' : '#d9d9d9',
    },
  };

  // Update all existing charts
  ['chart-allocation', 'chart-account-type', 'chart-history', 'chart-projection'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.data) {
      Plotly.relayout(id, layout);
    }
  });
}

// Demo Mode Management
let currentDemoMode = false;

async function checkDemoModeStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/settings/demo-mode`);
    if (response.ok) {
      const data = await response.json();
      updateDemoModeUI(data.enabled);
      return data.enabled;
    }
  } catch (error) {
    console.error('Error checking demo mode:', error);
  }
  return false;
}

function updateDemoModeUI(isEnabled) {
  currentDemoMode = isEnabled;

  // Update toggle checkbox
  const toggle = document.getElementById('demo-mode-toggle');
  if (toggle) {
    toggle.checked = isEnabled;
  }

  // Update status badge
  const statusBadge = document.getElementById('demo-mode-status');
  if (statusBadge) {
    statusBadge.textContent = isEnabled ? 'Active' : 'Off';
    statusBadge.className = `status-badge ${isEnabled ? 'active' : 'inactive'}`;
  }

  // Show/hide demo mode banner
  const banner = document.getElementById('demo-mode-banner');
  if (banner) {
    banner.style.display = isEnabled ? 'flex' : 'none';
  }
}

async function toggleDemoMode(enabled) {
  try {
    showLoading(enabled ? 'Switching to demo mode...' : 'Switching to personal portfolio...');

    const response = await fetch(`${API_BASE}/api/settings/demo-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

    if (response.ok) {
      const data = await response.json();
      showToast(enabled ? 'Demo mode enabled' : 'Restored personal portfolio', 'success');

      // CRITICAL: Clear view ID from localStorage when switching databases
      // Views are stored per-database, so old view IDs become invalid
      localStorage.removeItem('portfolioViewId');
      currentViewId = null;

      // Hard reload with cache busting to ensure fresh data from new database
      // Add timestamp to URL to bypass browser cache
      const url = new URL(window.location.href);
      url.searchParams.set('_t', Date.now());
      window.location.href = url.toString();
    } else {
      hideLoading();
      showToast('Failed to update demo mode', 'error');
      // Revert toggle on error
      const toggle = document.getElementById('demo-mode-toggle');
      if (toggle) {
        toggle.checked = !enabled;
      }
    }
  } catch (error) {
    hideLoading();
    console.error('Error toggling demo mode:', error);
    showToast('Failed to update demo mode', 'error');
    // Revert toggle on error
    const toggle = document.getElementById('demo-mode-toggle');
    if (toggle) {
      toggle.checked = !enabled;
    }
  }
}

async function generateDemoData() {
  const btn = document.getElementById('generate-demo-btn');
  const textSpan = document.getElementById('generate-demo-text');
  const spinner = document.getElementById('generate-demo-spinner');
  const resultSpan = document.getElementById('generate-demo-result');

  // Disable button and show spinner
  btn.disabled = true;
  textSpan.textContent = 'Generating...';
  spinner.style.display = 'inline-block';
  resultSpan.textContent = '';
  resultSpan.className = '';

  try {
    const response = await fetch(`${API_BASE}/api/settings/demo/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();

    if (data.success) {
      resultSpan.textContent = `✓ Created ${
        data.positions_created
      } positions worth $${data.total_value.toLocaleString()}`;
      resultSpan.style.color = 'var(--color-success)';
      showToast('Demo data generated successfully!', 'success');
    } else {
      resultSpan.textContent = `✗ ${data.error || 'Generation failed'}`;
      resultSpan.style.color = 'var(--color-danger)';
      showToast(`Failed to generate demo data: ${data.error}`, 'error');
      console.error('Demo generation error:', data);
    }
  } catch (error) {
    console.error('Error generating demo data:', error);
    resultSpan.textContent = '✗ Network error';
    resultSpan.style.color = 'var(--color-danger)';
    showToast('Failed to generate demo data', 'error');
  } finally {
    // Re-enable button
    btn.disabled = false;
    textSpan.textContent = 'Generate Demo Data';
    spinner.style.display = 'none';
  }
}

// Tab navigation
function showTab(tabName) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach((tab) => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.nav-item').forEach((nav) => {
    nav.classList.remove('active');
  });

  // Show selected tab
  const tabEl = document.getElementById(`tab-${tabName}`);
  if (tabEl) {
    tabEl.classList.add('active');
  }

  // Activate nav item
  const navItem = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // Load tab-specific data - always refresh to ensure current data
  if (tabName === 'dashboard') {
    refreshData();
  } else if (tabName === 'holdings') {
    refreshData();
  } else if (tabName === 'analysis') {
    loadAnalysisData();
  } else if (tabName === 'projections') {
    loadProjectionsSettings();
  } else if (tabName === 'taxes') {
    loadTaxesTab();
  } else if (tabName === 'budget') {
    loadBudgetTab();
  } else if (tabName === 'settings') {
    loadSettings();
    loadProfilesForSettings();
    loadPlugins();
    loadInstalledPlugins();
  }
}

// View management
async function loadViews() {
  try {
    const response = await fetch(`${API_BASE}/api/settings/views`);
    const views = await response.json();
    availableViews = views;

    const selector = document.getElementById('view-selector');
    selector.innerHTML = '';

    // Add "All Accounts" option first (empty value)
    views.forEach((view) => {
      const option = document.createElement('option');
      option.value = view.id;
      option.textContent = view.name;
      if (view.is_default && !currentViewId) {
        option.selected = true;
        currentViewId = view.id;
      } else if (view.id === currentViewId) {
        option.selected = true;
      }
      selector.appendChild(option);
    });

    // Save current view to localStorage
    if (currentViewId) {
      localStorage.setItem('portfolioViewId', currentViewId);
    }
  } catch (error) {
    console.error('Error loading views:', error);
  }
}

function changeView(viewId) {
  currentViewId = viewId || null;
  if (viewId) {
    localStorage.setItem('portfolioViewId', viewId);
  } else {
    localStorage.removeItem('portfolioViewId');
  }

  // Show current view name in toast
  const view = availableViews.find((v) => v.id === viewId);
  const viewName = view ? view.name : 'All Accounts';
  showToast(`Switched to: ${viewName}`, 'info');

  // Refresh data with new view
  refreshData();
}

// Profile management (multi-database support)
let availableProfiles = [];
let currentProfileId = null;

async function loadProfiles() {
  try {
    const response = await fetch(API_BASE + '/api/profiles');
    const profiles = await response.json();
    availableProfiles = profiles;

    // Find active profile
    const activeProfile = profiles.find((p) => p.is_active);
    if (activeProfile) {
      currentProfileId = activeProfile.id;
      updateProfileDisplay(activeProfile);
    }

    // Update dropdown list
    renderProfileDropdown(profiles);
  } catch (error) {
    console.error('Error loading profiles:', error);
  }
}

function updateProfileDisplay(profile) {
  const nameEl = document.getElementById('current-profile-name');
  const dotEl = document.getElementById('profile-color-dot');

  if (nameEl) nameEl.textContent = profile.name;
  if (dotEl) dotEl.style.backgroundColor = profile.color;
}

function renderProfileDropdown(profiles) {
  const listEl = document.getElementById('profile-list');
  if (!listEl) return;

  listEl.textContent = ''; // Clear existing content

  profiles.forEach((profile) => {
    const item = document.createElement('div');
    item.className = 'profile-item' + (profile.is_active ? ' active' : '');
    item.onclick = function () {
      switchProfile(profile.id);
    };

    const dot = document.createElement('span');
    dot.className = 'profile-color-dot';
    dot.style.backgroundColor = profile.color;

    const name = document.createElement('span');
    name.className = 'profile-item-name';
    name.textContent = profile.name;

    const check = document.createElement('span');
    check.className = 'profile-item-check';
    check.textContent = '\u2713'; // Checkmark

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(check);
    listEl.appendChild(item);
  });
}

function toggleProfileDropdown() {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) {
    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : 'block';

    // Close dropdown when clicking outside
    if (!isVisible) {
      setTimeout(function () {
        document.addEventListener('click', closeProfileDropdownOnClickOutside);
      }, 0);
    }
  }
}

function closeProfileDropdownOnClickOutside(event) {
  const dropdown = document.getElementById('profile-dropdown');
  const btn = document.getElementById('profile-selector-btn');

  if (dropdown && btn && !dropdown.contains(event.target) && !btn.contains(event.target)) {
    dropdown.style.display = 'none';
    document.removeEventListener('click', closeProfileDropdownOnClickOutside);
  }
}

async function switchProfile(profileId) {
  if (profileId === currentProfileId) {
    toggleProfileDropdown();
    return;
  }

  showLoading('Switching profile...');

  try {
    const response = await fetch(API_BASE + '/api/profiles/' + profileId + '/activate', {
      method: 'POST',
    });

    if (response.ok) {
      const profile = await response.json();
      currentProfileId = profile.id;
      updateProfileDisplay(profile);

      // Update dropdown to reflect new active profile
      await loadProfiles();

      // Close dropdown
      const dropdown = document.getElementById('profile-dropdown');
      if (dropdown) dropdown.style.display = 'none';

      showToast('Switched to profile: ' + profile.name, 'success');

      // Clear AI commentary cache when switching databases
      clearCommentaryCache();

      // Reload all data for new profile
      await refreshData();
      await loadViews();
    } else {
      const error = await response.json();
      showToast('Error: ' + error.detail, 'error');
    }
  } catch (error) {
    console.error('Error switching profile:', error);
    showToast('Failed to switch profile', 'error');
  } finally {
    hideLoading();
  }
}

function showManageProfilesModal() {
  // Close dropdown first
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  // Navigate to settings tab and scroll to profiles section
  showTab('settings');
  setTimeout(function () {
    const profilesSection = document.getElementById('profiles-management-list');
    if (profilesSection) {
      profilesSection.scrollIntoView({ behavior: 'smooth' });
    }
  }, 100);
}

// Profile Management for Settings page
async function loadProfilesForSettings() {
  try {
    const response = await fetch(API_BASE + '/api/profiles');
    const profiles = await response.json();
    renderProfilesManagementList(profiles);
  } catch (error) {
    console.error('Error loading profiles for settings:', error);
  }
}

function renderProfilesManagementList(profiles) {
  const container = document.getElementById('profiles-management-list');
  if (!container) return;

  if (profiles.length === 0) {
    container.innerHTML = '<p class="text-muted">No profiles found. Create one to get started.</p>';
    return;
  }

  const iconSvgs = {
    user: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
    users:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    briefcase:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>',
    building:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><line x1="9" y1="6" x2="9" y2="6.01"></line><line x1="15" y1="6" x2="15" y2="6.01"></line><line x1="9" y1="10" x2="9" y2="10.01"></line><line x1="15" y1="10" x2="15" y2="10.01"></line><line x1="9" y1="14" x2="9" y2="14.01"></line><line x1="15" y1="14" x2="15" y2="14.01"></line><line x1="9" y1="18" x2="15" y2="18"></line></svg>',
    star: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
    shield:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>',
  };

  container.innerHTML = profiles
    .map(function (profile) {
      const iconSvg = iconSvgs[profile.icon] || iconSvgs.user;
      const isActive = profile.is_active;
      const activeBadge = isActive ? '<span class="badge badge-success">Active</span>' : '';
      const lastAccessed = profile.last_accessed ? new Date(profile.last_accessed).toLocaleDateString() : 'Never';

      return (
        '<div class="profile-management-card' +
        (isActive ? ' active' : '') +
        '">' +
        '<div class="profile-card-icon" style="background-color: ' +
        escapeHtml(profile.color) +
        '">' +
        iconSvg +
        '</div>' +
        '<div class="profile-card-info">' +
        '<div class="profile-card-name">' +
        escapeHtml(profile.name) +
        ' ' +
        activeBadge +
        '</div>' +
        '<div class="profile-card-description">' +
        escapeHtml(profile.description || 'No description') +
        '</div>' +
        '<div class="profile-card-stats">Last accessed: ' +
        lastAccessed +
        '</div>' +
        '</div>' +
        '<div class="profile-card-actions">' +
        (!isActive
          ? '<button class="btn btn-sm btn-primary" onclick="activateProfile(\'' +
            profile.id +
            '\')" title="Activate">Activate</button>'
          : '') +
        '<button class="btn btn-sm btn-default" onclick="editProfile(\'' +
        profile.id +
        '\')" title="Edit">Edit</button>' +
        '<button class="btn btn-sm btn-default" onclick="exportProfile(\'' +
        profile.id +
        '\')" title="Export">Export</button>' +
        '<button class="btn btn-sm btn-default" onclick="duplicateProfile(\'' +
        profile.id +
        '\')" title="Duplicate">Duplicate</button>' +
        (!isActive && profiles.length > 1
          ? '<button class="btn btn-sm btn-danger" onclick="deleteProfile(\'' +
            profile.id +
            '\')" title="Delete">Delete</button>'
          : '') +
        '</div>' +
        '</div>'
      );
    })
    .join('');
}

function showCreateProfileModal() {
  document.getElementById('profile-modal-title').textContent = 'Create Profile';
  document.getElementById('profile-id').value = '';
  document.getElementById('profile-name').value = '';
  document.getElementById('profile-description').value = '';

  // Reset color and icon to defaults
  const colorRadios = document.querySelectorAll('input[name="profile-color"]');
  colorRadios.forEach(function (r, i) {
    r.checked = i === 0;
  });

  const iconRadios = document.querySelectorAll('input[name="profile-icon"]');
  iconRadios.forEach(function (r, i) {
    r.checked = i === 0;
  });

  document.getElementById('profile-modal').style.display = 'flex';
}

function hideProfileModal() {
  document.getElementById('profile-modal').style.display = 'none';
}

async function editProfile(profileId) {
  try {
    const response = await fetch(API_BASE + '/api/profiles/' + profileId);
    if (!response.ok) throw new Error('Profile not found');
    const profile = await response.json();

    document.getElementById('profile-modal-title').textContent = 'Edit Profile';
    document.getElementById('profile-id').value = profile.id;
    document.getElementById('profile-name').value = profile.name;
    document.getElementById('profile-description').value = profile.description || '';

    // Set color
    const colorRadios = document.querySelectorAll('input[name="profile-color"]');
    colorRadios.forEach(function (r) {
      r.checked = r.value === profile.color;
    });

    // Set icon
    const iconRadios = document.querySelectorAll('input[name="profile-icon"]');
    iconRadios.forEach(function (r) {
      r.checked = r.value === profile.icon;
    });

    document.getElementById('profile-modal').style.display = 'flex';
  } catch (error) {
    console.error('Error loading profile:', error);
    showToast('Failed to load profile', 'error');
  }
}

async function saveProfile(event) {
  event.preventDefault();

  const profileId = document.getElementById('profile-id').value;
  const name = document.getElementById('profile-name').value.trim();
  const description = document.getElementById('profile-description').value.trim();
  const color = document.querySelector('input[name="profile-color"]:checked').value;
  const icon = document.querySelector('input[name="profile-icon"]:checked').value;

  if (!name) {
    showToast('Profile name is required', 'error');
    return;
  }

  try {
    let response;
    if (profileId) {
      // Update existing profile
      response = await fetch(API_BASE + '/api/profiles/' + profileId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, description: description, color: color, icon: icon }),
      });
    } else {
      // Create new profile
      response = await fetch(API_BASE + '/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, description: description, color: color, icon: icon }),
      });
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to save profile');
    }

    hideProfileModal();
    showToast(profileId ? 'Profile updated' : 'Profile created', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error saving profile:', error);
    showToast(error.message, 'error');
  }
}

async function activateProfile(profileId) {
  try {
    const response = await fetch(API_BASE + '/api/profiles/' + profileId + '/activate', {
      method: 'POST',
    });

    if (!response.ok) throw new Error('Failed to activate profile');

    showToast('Profile activated. Reloading...', 'success');

    // Reload everything to use new database
    await loadProfiles();
    await loadProfilesForSettings();
    await refreshData();
  } catch (error) {
    console.error('Error activating profile:', error);
    showToast('Failed to activate profile', 'error');
  }
}

async function deleteProfile(profileId) {
  if (
    !confirm(
      'Are you sure you want to delete this profile? This will permanently delete all data in this profile and cannot be undone.'
    )
  ) {
    return;
  }

  try {
    const response = await fetch(API_BASE + '/api/profiles/' + profileId, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to delete profile');
    }

    showToast('Profile deleted', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error deleting profile:', error);
    showToast(error.message, 'error');
  }
}

async function duplicateProfile(profileId) {
  const newName = prompt('Enter name for the duplicate profile:');
  if (!newName) return;

  try {
    const response = await fetch(API_BASE + '/api/profiles/' + profileId + '/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: newName }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to duplicate profile');
    }

    showToast('Profile duplicated', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error duplicating profile:', error);
    showToast(error.message, 'error');
  }
}

async function exportProfile(profileId) {
  try {
    showToast('Preparing export...', 'info');
    const response = await fetch(API_BASE + '/api/profiles/' + profileId + '/export');

    if (!response.ok) throw new Error('Failed to export profile');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Get filename from Content-Disposition header or use default
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = 'profile-export.zip';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    showToast('Profile exported successfully', 'success');
  } catch (error) {
    console.error('Error exporting profile:', error);
    showToast('Failed to export profile', 'error');
  }
}

function importProfileFromFile() {
  document.getElementById('profile-import-input').click();
}

async function handleProfileImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast('Importing profile...', 'info');
    const response = await fetch(API_BASE + '/api/profiles/import', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to import profile');
    }

    const result = await response.json();
    showToast('Profile "' + result.name + '" imported successfully', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error importing profile:', error);
    showToast(error.message, 'error');
  }

  // Reset the input
  event.target.value = '';
}

// Plugin Management
let availablePlugins = [];

async function loadPlugins() {
  try {
    const response = await fetch(API_BASE + '/api/plugins');
    const plugins = await response.json();
    availablePlugins = plugins;
    renderPluginsList(plugins);
  } catch (error) {
    console.error('Error loading plugins:', error);
    const container = document.getElementById('plugins-list');
    if (container) {
      container.innerHTML = '<p class="text-muted">Failed to load plugins.</p>';
    }
  }
}

async function discoverPlugins() {
  try {
    showToast('Scanning for plugins...', 'info');
    const response = await fetch(API_BASE + '/api/plugins/discover', { method: 'POST' });
    const result = await response.json();
    showToast('Found ' + result.discovered + ' plugins', 'success');
    await loadPlugins();
  } catch (error) {
    console.error('Error discovering plugins:', error);
    showToast('Failed to discover plugins', 'error');
  }
}

function renderPluginsList(plugins) {
  const container = document.getElementById('plugins-list');
  if (!container) return;

  if (plugins.length === 0) {
    container.innerHTML =
      '<div class="plugins-empty">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>' +
      '<line x1="9" y1="9" x2="15" y2="15"></line>' +
      '<line x1="15" y1="9" x2="9" y2="15"></line>' +
      '</svg>' +
      '<p>No plugins installed</p>' +
      '<p class="text-muted" style="font-size: 12px;">Add plugins to the <code>src/plugins/installed/</code> directory</p>' +
      '</div>';
    return;
  }

  const typeIcons = {
    importer:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
    analysis:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
    widget:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
    provider:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
    export:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  };

  container.innerHTML = plugins
    .map(function (plugin) {
      var cardClasses = 'plugin-card';
      if (plugin.enabled) cardClasses += ' enabled';
      if (plugin.load_error) cardClasses += ' has-error';

      var icon = typeIcons[plugin.plugin_type] || typeIcons.widget;

      return (
        '<div class="' +
        cardClasses +
        '">' +
        '<div class="plugin-icon ' +
        plugin.plugin_type +
        '">' +
        icon +
        '</div>' +
        '<div class="plugin-info">' +
        '<div class="plugin-header">' +
        '<span class="plugin-name">' +
        escapeHtml(plugin.name) +
        '</span>' +
        '<span class="plugin-version">v' +
        escapeHtml(plugin.version) +
        '</span>' +
        '<span class="plugin-type-badge">' +
        plugin.plugin_type +
        '</span>' +
        (plugin.is_builtin ? '<span class="badge badge-default">Built-in</span>' : '') +
        '</div>' +
        '<div class="plugin-description">' +
        escapeHtml(plugin.description || 'No description') +
        '</div>' +
        '<div class="plugin-meta">By ' +
        escapeHtml(plugin.author) +
        ' | ' +
        escapeHtml(plugin.license) +
        '</div>' +
        (plugin.load_error ? '<div class="plugin-error">Error: ' + escapeHtml(plugin.load_error) + '</div>' : '') +
        '</div>' +
        '<div class="plugin-actions">' +
        (plugin.enabled
          ? '<button class="btn btn-sm btn-default" onclick="togglePlugin(\'' +
            plugin.plugin_id +
            '\', false)">Disable</button>'
          : '<button class="btn btn-sm btn-primary" onclick="togglePlugin(\'' +
            plugin.plugin_id +
            '\', true)"' +
            (plugin.load_error ? ' disabled' : '') +
            '>Enable</button>') +
        (plugin.settings_schema && plugin.settings_schema.length > 0
          ? '<button class="btn btn-sm btn-default" onclick="showPluginSettings(\'' +
            plugin.plugin_id +
            '\')">Settings</button>'
          : '') +
        '</div>' +
        '</div>'
      );
    })
    .join('');
}

async function togglePlugin(pluginId, enable) {
  try {
    const response = await fetch(API_BASE + '/api/plugins/' + pluginId + '/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: enable }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to toggle plugin');
    }

    showToast(enable ? 'Plugin enabled' : 'Plugin disabled', 'success');
    await loadPlugins();
  } catch (error) {
    console.error('Error toggling plugin:', error);
    showToast(error.message, 'error');
  }
}

async function showPluginSettings(pluginId) {
  try {
    const response = await fetch(API_BASE + '/api/plugins/' + pluginId + '/settings');
    if (!response.ok) throw new Error('Failed to load settings');
    const data = await response.json();

    var content = '<form id="plugin-settings-form" onsubmit="savePluginSettings(event, \'' + pluginId + '\')">';

    data.schema.forEach(function (setting) {
      content += '<div class="form-group">';
      content += '<label for="plugin-' + setting.key + '">' + escapeHtml(setting.label) + '</label>';

      var value = data.settings[setting.key];
      if (value === undefined) value = setting.default;

      if (setting.type === 'select') {
        content += '<select id="plugin-' + setting.key + '" name="' + setting.key + '">';
        setting.options.forEach(function (opt) {
          content +=
            '<option value="' +
            escapeHtml(opt) +
            '"' +
            (value === opt ? ' selected' : '') +
            '>' +
            escapeHtml(opt) +
            '</option>';
        });
        content += '</select>';
      } else if (setting.type === 'boolean') {
        content += '<label class="toggle-switch">';
        content +=
          '<input type="checkbox" id="plugin-' +
          setting.key +
          '" name="' +
          setting.key +
          '"' +
          (value ? ' checked' : '') +
          '>';
        content += '<span class="toggle-slider"></span>';
        content += '</label>';
      } else if (setting.type === 'number') {
        content +=
          '<input type="number" id="plugin-' +
          setting.key +
          '" name="' +
          setting.key +
          '" value="' +
          (value || '') +
          '">';
      } else {
        content +=
          '<input type="text" id="plugin-' +
          setting.key +
          '" name="' +
          setting.key +
          '" value="' +
          escapeHtml(value || '') +
          '">';
      }

      if (setting.description) {
        content += '<small class="form-help">' + escapeHtml(setting.description) + '</small>';
      }
      content += '</div>';
    });

    content += '<div class="modal-footer">';
    content += '<button type="button" class="btn btn-default" onclick="closeModal()">Cancel</button>';
    content += '<button type="submit" class="btn btn-primary">Save Settings</button>';
    content += '</div></form>';

    document.getElementById('generic-modal-title').textContent = 'Plugin Settings';
    document.getElementById('generic-modal-body').innerHTML = content;
    document.getElementById('generic-modal').style.display = 'flex';
  } catch (error) {
    console.error('Error loading plugin settings:', error);
    showToast('Failed to load plugin settings', 'error');
  }
}

async function savePluginSettings(event, pluginId) {
  event.preventDefault();
  var form = event.target;
  var settings = {};

  var plugin = availablePlugins.find(function (p) {
    return p.plugin_id === pluginId;
  });
  if (plugin && plugin.settings_schema) {
    plugin.settings_schema.forEach(function (setting) {
      var input = form.querySelector('[name="' + setting.key + '"]');
      if (input) {
        if (setting.type === 'boolean') {
          settings[setting.key] = input.checked;
        } else if (setting.type === 'number') {
          settings[setting.key] = parseFloat(input.value) || 0;
        } else {
          settings[setting.key] = input.value;
        }
      }
    });
  }

  try {
    const response = await fetch(API_BASE + '/api/plugins/' + pluginId + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: settings }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to save settings');
    }

    closeModal();
    showToast('Settings saved', 'success');
  } catch (error) {
    console.error('Error saving plugin settings:', error);
    showToast(error.message, 'error');
  }
}

// Plugin Analysis
async function loadPluginAnalysis() {
  var container = document.getElementById('plugin-insights-container');
  var loading = document.getElementById('plugin-insights-loading');

  if (loading) loading.style.display = 'block';
  if (container) container.innerHTML = '';

  try {
    const response = await fetch(API_BASE + '/api/analysis/plugins');
    if (!response.ok) throw new Error('Failed to load analysis');
    const data = await response.json();

    if (loading) loading.style.display = 'none';

    if (!data.plugins || data.plugins.length === 0) {
      container.innerHTML = '<p class="text-muted">No analysis plugins available.</p>';
      return;
    }

    var html = '';

    // Show each plugin's results
    data.plugins.forEach(function (plugin) {
      html += '<div class="plugin-result">';
      html += '<h4>' + escapeHtml(plugin.plugin_name) + '</h4>';

      // Show key metrics
      if (plugin.metrics) {
        html += '<div class="plugin-metrics">';

        // Tax-Loss Harvester metrics
        if (plugin.metrics.total_unrealized_losses !== undefined) {
          html += '<div class="metric-item">';
          html +=
            '<span class="metric-value negative">$' + formatNumber(plugin.metrics.total_unrealized_losses) + '</span>';
          html += '<span class="metric-label">Unrealized Losses</span>';
          html += '</div>';
          html += '<div class="metric-item">';
          html +=
            '<span class="metric-value positive">$' + formatNumber(plugin.metrics.estimated_tax_savings) + '</span>';
          html += '<span class="metric-label">Est. Tax Savings</span>';
          html += '</div>';
          html += '<div class="metric-item">';
          html += '<span class="metric-value">' + plugin.metrics.harvesting_opportunities + '</span>';
          html += '<span class="metric-label">Opportunities</span>';
          html += '</div>';
        }

        // Dividend Tracker metrics
        if (plugin.metrics.estimated_annual_income !== undefined) {
          html += '<div class="metric-item">';
          html +=
            '<span class="metric-value positive">$' + formatNumber(plugin.metrics.estimated_annual_income) + '</span>';
          html += '<span class="metric-label">Est. Annual Dividends</span>';
          html += '</div>';
          html += '<div class="metric-item">';
          html += '<span class="metric-value">' + plugin.metrics.portfolio_yield.toFixed(2) + '%</span>';
          html += '<span class="metric-label">Portfolio Yield</span>';
          html += '</div>';
          html += '<div class="metric-item">';
          html +=
            '<span class="metric-value">$' + formatNumber(plugin.metrics.monthly_income_estimate || 0) + '</span>';
          html += '<span class="metric-label">Monthly Income</span>';
          html += '</div>';
        }

        html += '</div>';
      }

      // Show insights
      if (plugin.insights && plugin.insights.length > 0) {
        html += '<div class="plugin-insights-list">';
        plugin.insights.forEach(function (insight) {
          html += '<p class="insight-item">' + escapeHtml(insight) + '</p>';
        });
        html += '</div>';
      }

      html += '</div>';
    });

    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading plugin analysis:', error);
    if (loading) loading.style.display = 'none';
    container.innerHTML = '<p class="text-muted">Failed to load analysis. ' + escapeHtml(error.message) + '</p>';
  }
}

// Widget Dashboard
async function loadWidgets() {
  var container = document.getElementById('widget-grid');
  var loading = document.getElementById('widget-loading');

  if (loading) loading.style.display = 'block';
  if (container) container.innerHTML = '';

  try {
    const response = await fetch(API_BASE + '/api/analysis/widgets');
    if (!response.ok) throw new Error('Failed to load widgets');
    const data = await response.json();

    if (loading) loading.style.display = 'none';

    if (!data.widgets || data.widgets.length === 0) {
      container.innerHTML = '<p class="text-muted">No widget plugins available.</p>';
      return;
    }

    var html = '';

    // Render each widget
    data.widgets.forEach(function (widget) {
      if (!widget.success) {
        html += '<div class="widget-item widget-error">';
        html += '<div class="widget-header">';
        html += '<h4>' + escapeHtml(widget.plugin_name) + '</h4>';
        html += '</div>';
        html += '<div class="widget-body">';
        html += '<p class="text-muted">Error: ' + escapeHtml(widget.error || 'Unknown error') + '</p>';
        html += '</div>';
        html += '</div>';
        return;
      }

      var config = widget.config || {};
      var content = widget.content || {};
      var widthClass = 'widget-w' + (config.default_width || 1);
      var heightClass = 'widget-h' + (config.default_height || 1);

      html += '<div class="widget-item ' + widthClass + ' ' + heightClass + '">';
      html += '<div class="widget-header">';
      html += '<h4>' + escapeHtml(config.title || widget.plugin_name) + '</h4>';
      html += '</div>';
      html += '<div class="widget-body">';

      // Render widget content HTML
      if (content.html) {
        html += content.html;
      } else {
        html += '<p class="text-muted">No content to display.</p>';
      }

      html += '</div>';
      html += '</div>';
    });

    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading widgets:', error);
    if (loading) loading.style.display = 'none';
    container.innerHTML = '<p class="text-muted">Failed to load widgets. ' + escapeHtml(error.message) + '</p>';
  }
}

// Plugin Security
async function loadPluginSecurity() {
  var container = document.getElementById('plugin-security-container');
  var auditContainer = document.getElementById('security-audit-container');

  if (container) container.innerHTML = '<p class="text-muted">Loading...</p>';

  try {
    // Load permissions
    const permResponse = await fetch(API_BASE + '/api/plugins/security/permissions');
    if (!permResponse.ok) throw new Error('Failed to load permissions');
    const permData = await permResponse.json();

    // Load audit log
    const auditResponse = await fetch(API_BASE + '/api/plugins/security/audit?limit=20');
    const auditData = auditResponse.ok ? await auditResponse.json() : { entries: [] };

    // Render permissions table
    var html = '<table class="data-table compact-table">';
    html += '<thead><tr><th>Plugin</th><th>Type</th><th>Permissions</th><th>Status</th><th>Actions</th></tr></thead>';
    html += '<tbody>';

    permData.plugins.forEach(function (plugin) {
      var permList = [];
      if (plugin.requested.file_read) permList.push('file_read');
      if (plugin.requested.file_write) permList.push('<span class="text-warning">file_write</span>');
      if (plugin.requested.network) permList.push('<span class="text-warning">network</span>');
      if (plugin.requested.database !== 'none') permList.push('db:' + plugin.requested.database);

      var status = '';
      var actions = '';

      if (plugin.is_builtin) {
        status = '<span class="badge badge-success">Built-in</span>';
        actions = '<span class="text-muted">-</span>';
      } else if (plugin.approved) {
        status = '<span class="badge badge-success">Approved</span>';
        actions =
          '<button class="btn btn-xs btn-danger" onclick="revokePluginPermissions(\'' +
          plugin.plugin_id +
          '\')">Revoke</button>';
      } else if (plugin.needs_approval) {
        status = '<span class="badge badge-warning">Pending</span>';
        actions =
          '<button class="btn btn-xs btn-primary" onclick="approvePluginPermissions(\'' +
          plugin.plugin_id +
          '\', true)">Approve</button> ';
        actions +=
          '<button class="btn btn-xs btn-danger" onclick="approvePluginPermissions(\'' +
          plugin.plugin_id +
          '\', false)">Deny</button>';
      } else {
        status = '<span class="badge badge-default">No sensitive perms</span>';
        actions = '<span class="text-muted">-</span>';
      }

      html += '<tr>';
      html += '<td>' + escapeHtml(plugin.name) + '</td>';
      html += '<td>' + (plugin.is_builtin ? 'Built-in' : 'Installed') + '</td>';
      html += '<td>' + (permList.length > 0 ? permList.join(', ') : 'None') + '</td>';
      html += '<td>' + status + '</td>';
      html += '<td>' + actions + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';

    if (permData.pending_count > 0) {
      html =
        '<div class="alert alert-warning" style="margin-bottom: 15px;">' +
        '<strong>' +
        permData.pending_count +
        ' plugin(s)</strong> require permission approval before they can be loaded.' +
        '</div>' +
        html;
    }

    container.innerHTML = html;

    // Render audit log
    if (auditData.entries && auditData.entries.length > 0) {
      var auditHtml = '<div class="audit-log">';
      auditData.entries.slice(0, 10).forEach(function (entry) {
        var time = new Date(entry.timestamp).toLocaleString();
        var icon = entry.success ? '✓' : '✗';
        var cssClass = entry.success ? 'audit-success' : 'audit-failure';
        auditHtml += '<div class="audit-entry ' + cssClass + '">';
        auditHtml += '<span class="audit-icon">' + icon + '</span>';
        auditHtml += '<span class="audit-time">' + time + '</span>';
        auditHtml += '<span class="audit-event">' + escapeHtml(entry.event_type) + '</span>';
        auditHtml += '<span class="audit-plugin">' + escapeHtml(entry.plugin_id) + '</span>';
        auditHtml += '</div>';
      });
      auditHtml += '</div>';
      auditContainer.innerHTML = auditHtml;
    } else {
      auditContainer.innerHTML = '<p class="text-muted">No security events recorded.</p>';
    }
  } catch (error) {
    console.error('Error loading plugin security:', error);
    container.innerHTML = '<p class="text-muted">Failed to load plugin security. ' + escapeHtml(error.message) + '</p>';
  }
}

async function approvePluginPermissions(pluginId, approve) {
  try {
    const response = await fetch(API_BASE + '/api/plugins/security/permissions/' + pluginId + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: approve }),
    });

    if (!response.ok) throw new Error('Failed to update permissions');

    showToast(approve ? 'Permissions approved' : 'Permissions denied', 'success');
    loadPluginSecurity();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

async function revokePluginPermissions(pluginId) {
  if (!confirm('Revoke permissions for this plugin? It will be disabled and require re-approval.')) {
    return;
  }

  try {
    const response = await fetch(API_BASE + '/api/plugins/security/permissions/' + pluginId + '/revoke', {
      method: 'POST',
    });

    if (!response.ok) throw new Error('Failed to revoke permissions');

    showToast('Permissions revoked', 'success');
    loadPluginSecurity();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// Plugin Marketplace Functions
async function loadInstalledPlugins() {
  const container = document.getElementById('installed-plugins-container');
  if (!container) return;

  try {
    const response = await fetch(API_BASE + '/api/plugins/installed');
    if (!response.ok) throw new Error('Failed to load installed plugins');

    const data = await response.json();

    if (data.count === 0) {
      container.innerHTML = `
                <div class="empty-state">
                    <p class="text-muted">No third-party plugins installed.</p>
                    <p class="text-muted">Click "Install Plugin" to add plugins from Git or upload a ZIP file.</p>
                </div>
            `;
      return;
    }

    container.innerHTML = `
            <div class="installed-plugins-list">
                ${data.plugins
                  .map(
                    (plugin) => `
                    <div class="installed-plugin-card" data-plugin-id="${escapeHtml(plugin.plugin_id)}">
                        <div class="plugin-info">
                            <div class="plugin-header">
                                <span class="plugin-name">${escapeHtml(plugin.name)}</span>
                                <span class="plugin-version">v${escapeHtml(plugin.version)}</span>
                                <span class="plugin-type badge badge-${getPluginTypeBadgeClass(
                                  plugin.plugin_type
                                )}">${escapeHtml(plugin.plugin_type)}</span>
                            </div>
                            <p class="plugin-description">${escapeHtml(plugin.description || 'No description')}</p>
                            <div class="plugin-meta">
                                <span class="plugin-author">By ${escapeHtml(plugin.author || 'Unknown')}</span>
                                ${
                                  plugin.source
                                    ? `
                                    <span class="plugin-source">
                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                            ${
                                              plugin.source.type === 'git'
                                                ? '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>'
                                                : '<rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M12 12l-4-4-4 4"></path>'
                                            }
                                        </svg>
                                        ${escapeHtml(plugin.source.url || plugin.source.type)}
                                    </span>
                                `
                                    : ''
                                }
                            </div>
                        </div>
                        <div class="plugin-actions">
                            ${
                              plugin.source && plugin.source.type === 'git'
                                ? `
                                <button class="btn btn-sm btn-default" onclick="checkPluginUpdate('${escapeHtml(
                                  plugin.plugin_id
                                )}')" title="Check for updates">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="23 4 23 10 17 10"></polyline>
                                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                                    </svg>
                                </button>
                            `
                                : ''
                            }
                            <button class="btn btn-sm btn-danger" onclick="uninstallPlugin('${escapeHtml(
                              plugin.plugin_id
                            )}')" title="Uninstall plugin">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                `
                  )
                  .join('')}
            </div>
        `;
  } catch (error) {
    console.error('Error loading installed plugins:', error);
    container.innerHTML =
      '<p class="text-muted">Failed to load installed plugins. ' + escapeHtml(error.message) + '</p>';
  }
}

function getPluginTypeBadgeClass(pluginType) {
  const classes = {
    importer: 'info',
    analysis: 'success',
    widget: 'warning',
    provider: 'primary',
    export: 'secondary',
  };
  return classes[pluginType] || 'default';
}

function showInstallPluginModal() {
  document.getElementById('install-plugin-modal').style.display = 'flex';
  document.getElementById('git-source').value = '';
  document.getElementById('plugin-file').value = '';
  document.getElementById('upload-file-name').textContent = 'Drag and drop or click to select a ZIP file';
  switchInstallTab('git');
}

function hideInstallPluginModal() {
  document.getElementById('install-plugin-modal').style.display = 'none';
}

function switchInstallTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.install-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('.install-tab-content').forEach((content) => {
    content.style.display = content.id === `install-tab-${tabName}` ? 'block' : 'none';
  });
}

async function installFromGit(event) {
  event.preventDefault();

  const source = document.getElementById('git-source').value.trim();
  if (!source) {
    showToast('Please enter a repository source', 'error');
    return;
  }

  const btn = document.getElementById('git-install-btn');
  const btnText = btn.querySelector('.btn-text');
  const btnLoading = btn.querySelector('.btn-loading');

  // Show loading state
  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline-flex';

  try {
    const bodyString = JSON.stringify({ source: source });
    const signatureHeaders = await generateSignatureHeaders('POST', '/api/plugins/install/git', bodyString);
    const response = await fetch(API_BASE + '/api/plugins/install/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signatureHeaders },
      credentials: 'include',
      body: bodyString,
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || data.errors?.join(', ') || 'Installation failed');
    }

    showToast(`Successfully installed ${data.plugin_name} v${data.version}`, 'success');
    hideInstallPluginModal();
    loadInstalledPlugins();
    loadPluginSecurity();
  } catch (error) {
    showToast('Installation failed: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
  }
}

function handlePluginFileSelect(event) {
  const file = event.target.files[0];
  const nameDisplay = document.getElementById('upload-file-name');

  if (file) {
    nameDisplay.textContent = file.name;
  } else {
    nameDisplay.textContent = 'Drag and drop or click to select a ZIP file';
  }
}

async function installFromUpload(event) {
  event.preventDefault();

  const fileInput = document.getElementById('plugin-file');
  const file = fileInput.files[0];

  if (!file) {
    showToast('Please select a ZIP file', 'error');
    return;
  }

  const btn = document.getElementById('upload-install-btn');
  const btnText = btn.querySelector('.btn-text');
  const btnLoading = btn.querySelector('.btn-loading');

  // Show loading state
  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline-flex';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const signatureHeaders = await generateSignatureHeaders('POST', '/api/plugins/install/upload');
    const response = await fetch(API_BASE + '/api/plugins/install/upload', {
      method: 'POST',
      headers: signatureHeaders,
      credentials: 'include',
      body: formData,
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || data.errors?.join(', ') || 'Installation failed');
    }

    showToast(`Successfully installed ${data.plugin_name} v${data.version}`, 'success');
    hideInstallPluginModal();
    loadInstalledPlugins();
    loadPluginSecurity();
  } catch (error) {
    showToast('Installation failed: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
  }
}

async function uninstallPlugin(pluginId) {
  if (!confirm(`Are you sure you want to uninstall this plugin? This cannot be undone.`)) {
    return;
  }

  try {
    const signatureHeaders = await generateSignatureHeaders('DELETE', '/api/plugins/installed/' + pluginId);
    const response = await fetch(API_BASE + '/api/plugins/installed/' + pluginId, {
      method: 'DELETE',
      headers: signatureHeaders,
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Uninstall failed');
    }

    showToast('Plugin uninstalled successfully', 'success');
    loadInstalledPlugins();
    loadPluginSecurity();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

async function checkPluginUpdate(pluginId) {
  try {
    const response = await fetch(API_BASE + '/api/plugins/installed/' + pluginId + '/updates');
    if (!response.ok) throw new Error('Failed to check for updates');

    const data = await response.json();

    if (data.has_update) {
      if (
        confirm(`Update available: ${data.current_commit} → ${data.latest_commit}\n\nWould you like to update now?`)
      ) {
        await updatePlugin(pluginId);
      }
    } else {
      showToast('Plugin is up to date', 'info');
    }
  } catch (error) {
    showToast('Error checking for updates: ' + error.message, 'error');
  }
}

async function updatePlugin(pluginId) {
  try {
    const signatureHeaders = await generateSignatureHeaders('POST', '/api/plugins/installed/' + pluginId + '/update');
    const response = await fetch(API_BASE + '/api/plugins/installed/' + pluginId + '/update', {
      method: 'POST',
      headers: signatureHeaders,
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Update failed');
    }

    showToast(`Successfully updated ${data.plugin_name} to v${data.version}`, 'success');
    loadInstalledPlugins();
    loadPluginSecurity();
  } catch (error) {
    showToast('Error updating plugin: ' + error.message, 'error');
  }
}

async function checkPluginUpdates() {
  const banner = document.getElementById('updates-available-banner');
  const countEl = document.getElementById('updates-count');
  const messageEl = document.getElementById('updates-message');

  try {
    showToast('Checking for updates...', 'info');

    const signatureHeaders = await generateSignatureHeaders('POST', '/api/plugins/installed/check-updates');
    const response = await fetch(API_BASE + '/api/plugins/installed/check-updates', {
      method: 'POST',
      headers: signatureHeaders,
      credentials: 'include',
    });

    if (!response.ok) throw new Error('Failed to check for updates');

    const data = await response.json();

    if (data.count > 0) {
      banner.style.display = 'flex';
      countEl.textContent = `${data.count} Update${data.count > 1 ? 's' : ''} Available`;
      messageEl.textContent = data.updates_available.map((u) => u.plugin_id).join(', ');
      showToast(`${data.count} plugin update(s) available`, 'info');
    } else {
      banner.style.display = 'none';
      showToast('All plugins are up to date', 'success');
    }
  } catch (error) {
    showToast('Error checking for updates: ' + error.message, 'error');
  }
}

// Data loading
async function refreshData() {
  showLoading('Loading data...');
  try {
    // Build URL with view filter
    let url = `${API_BASE}/api/dashboard/data`;
    if (currentViewId) {
      url += `?view_id=${currentViewId}`;
    }

    // Get data without refreshing prices
    const response = await fetch(url);
    const data = await response.json();

    updateSummary(data.summary);
    updateHoldings(data.positions);
    updateAllocationCharts(data.positions, data.summary);
    updateHistoryChart(data.history);
    updateAccountFilter(data.positions);

    currentPositions = data.positions;

    // Update account totals table with filtered accounts from dashboard data
    updateAccountTotalsTable(data.summary.accounts || []);

    // Update demo mode UI from response
    if (data.demo_mode !== undefined) {
      updateDemoModeUI(data.demo_mode);
    }

    // Check for duplicate positions
    await checkForDuplicates();

    // Load retirement metrics for dashboard row 2
    await loadRetirementMetrics();

    // Re-initialize AI commentary buttons after data loads
    initAICommentaryButtons();
  } catch (error) {
    console.error('Error loading data:', error);
    showToast('Failed to load portfolio data', 'error');
  } finally {
    hideLoading();
  }
}

async function loadRetirementMetrics() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/dashboard-metrics`);
    if (!response.ok) return;

    const metrics = await response.json();
    const needsSimulation = metrics.simulation_required;

    // Update Monthly Retirement Income (based on projected value at retirement)
    const monthlyIncomeEl = document.getElementById('monthly-retirement-income');
    const withdrawalLabel = document.getElementById('withdrawal-rate-label');
    if (monthlyIncomeEl) {
      if (metrics.monthly_retirement_income !== null) {
        monthlyIncomeEl.textContent = formatCurrency(metrics.monthly_retirement_income);
        if (withdrawalLabel) {
          withdrawalLabel.textContent = `at ${metrics.withdrawal_rate}% of projected portfolio`;
        }
      } else {
        monthlyIncomeEl.textContent = '--';
        if (withdrawalLabel) {
          withdrawalLabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Success Probability
    const successProbEl = document.getElementById('success-probability');
    const successSublabel = document.getElementById('success-sublabel');
    if (successProbEl) {
      if (metrics.success_probability !== null) {
        successProbEl.textContent = `${metrics.success_probability}%`;
        successProbEl.classList.remove('positive', 'negative');
        // Only add class if not empty (classList.add('') throws an error)
        if (metrics.success_probability >= 80) {
          successProbEl.classList.add('positive');
        } else if (metrics.success_probability < 50) {
          successProbEl.classList.add('negative');
        }
        if (successSublabel) {
          successSublabel.textContent = `of not running out by age 90`;
        }
      } else {
        successProbEl.textContent = '--';
        successProbEl.classList.remove('positive', 'negative');
        if (successSublabel) {
          successSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Earliest Retirement Age
    const retireAgeEl = document.getElementById('earliest-retirement-age');
    const retireSublabel = document.getElementById('retire-sublabel');
    if (retireAgeEl) {
      if (metrics.earliest_retirement_age != null && metrics.earliest_retirement_age !== undefined) {
        retireAgeEl.textContent = `Age ${metrics.earliest_retirement_age}`;
        if (retireSublabel) {
          retireSublabel.textContent = 'with 80%+ success rate';
        }
      } else {
        retireAgeEl.textContent = '--';
        if (retireSublabel) {
          retireSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update FIRE Number
    const fireNumberEl = document.getElementById('fire-number');
    const fireSublabel = document.getElementById('fire-sublabel');
    if (fireNumberEl) {
      if (metrics.fire_number !== null) {
        fireNumberEl.textContent = formatCurrency(metrics.fire_number);
        if (fireSublabel) {
          if (metrics.target_monthly_income) {
            fireSublabel.textContent = `for $${formatNumber(metrics.target_monthly_income)}/mo target`;
          } else {
            fireSublabel.textContent = `projected at age ${metrics.target_retirement_age}`;
          }
        }
      } else {
        fireNumberEl.textContent = '--';
        if (fireSublabel) {
          fireSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }
  } catch (error) {
    console.error('Error loading retirement metrics:', error);
  }
}

async function loadProjectionsSettings() {
  try {
    // Fetch personal settings to populate the projections form
    const response = await fetch(`${API_BASE}/api/settings/config`);
    const config = await response.json();

    if (config.personal) {
      // Calculate current age from DOB
      const dobStr = config.personal.dob;
      if (dobStr) {
        const dob = new Date(dobStr);
        const today = new Date();
        let age = today.getFullYear() - dob.getFullYear();
        const monthDiff = today.getMonth() - dob.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
          age--;
        }
        const currentAgeEl = document.getElementById('current-age');
        if (currentAgeEl) {
          currentAgeEl.value = age;
        }
      }

      // Set retirement age from personal settings
      const retirementAge = config.personal.retirement_age;
      if (retirementAge) {
        const retireAgeEl = document.getElementById('retirement-age');
        if (retireAgeEl) {
          retireAgeEl.value = retirementAge;
        }
      }
    }
  } catch (error) {
    console.error('Error loading projections settings:', error);
  }
}

// Alias for compatibility
function loadData() {
  refreshData();
}

async function refreshPrices(force = false) {
  showLoading('Refreshing prices from APIs...');
  try {
    // Refresh prices from external APIs (only stale ones unless forced)
    const url = force ? `${API_BASE}/api/imports/refresh-prices?force=true` : `${API_BASE}/api/imports/refresh-prices`;
    const response = await fetch(url, { method: 'POST' });
    const result = await response.json();

    // Then reload data
    await refreshData();

    if (result.all_fresh && result.updated === 0) {
      showToast('Prices are fresh (less than 24 hours old)', 'info');
    } else {
      showToast(`Prices updated: ${result.updated || 0} tickers`, 'success');
    }

    // Update price status display
    await updatePriceStatus();
  } catch (error) {
    console.error('Error refreshing prices:', error);
    showToast('Failed to refresh prices', 'error');
    hideLoading();
  }
}

async function updatePriceStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/imports/price-status`);
    const status = await response.json();

    const statusEl = document.getElementById('price-status');
    if (!statusEl) return;

    if (status.all_fresh) {
      // Calculate how long ago prices were updated
      const newestUpdate = status.newest_update ? new Date(status.newest_update) : null;
      const hoursAgo = newestUpdate ? Math.round((Date.now() - newestUpdate.getTime()) / (1000 * 60 * 60)) : null;

      statusEl.className = 'price-status fresh';
      statusEl.innerHTML = `<span class="status-dot"></span> Prices fresh${
        hoursAgo !== null ? ` (${hoursAgo}h ago)` : ''
      }`;
      statusEl.title = 'All prices updated within 24 hours';
    } else if (status.stale_tickers > 0) {
      statusEl.className = 'price-status stale';
      statusEl.innerHTML = `<span class="status-dot"></span> ${status.stale_tickers} stale`;
      statusEl.title = `${status.stale_tickers} ticker(s) need price updates`;
    } else {
      statusEl.className = 'price-status';
      statusEl.innerHTML = '';
    }
  } catch (error) {
    console.error('Error loading price status:', error);
  }
}

function updateSummary(summary) {
  document.getElementById('total-value').textContent = formatCurrency(summary.total_value);

  const gainLoss = summary.total_gain_loss;
  const gainLossEl = document.getElementById('gain-loss');
  gainLossEl.textContent = formatCurrency(gainLoss);
  gainLossEl.className = 'stat-value ' + (gainLoss >= 0 ? 'positive' : 'negative');

  document.getElementById('retirement-value').textContent = formatCurrency(summary.retirement_value);
  document.getElementById('taxable-value').textContent = formatCurrency(summary.taxable_value);
}

// Store duplicate data globally for the modal
let duplicatesData = [];

async function checkForDuplicates() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/duplicates`);
    const data = await response.json();

    duplicatesData = data.duplicates || [];
    const warningEl = document.getElementById('duplicate-warning');
    const messageEl = document.getElementById('duplicate-message');

    if (data.has_duplicates && warningEl) {
      warningEl.style.display = 'flex';
      const count = data.count;
      messageEl.textContent = `Found ${count} position${
        count > 1 ? 's' : ''
      } with identical tickers and quantities across different accounts. This may indicate duplicate entries.`;
    } else if (warningEl) {
      warningEl.style.display = 'none';
    }
  } catch (error) {
    console.error('Error checking for duplicates:', error);
  }
}

function showDuplicateDetails() {
  if (duplicatesData.length === 0) {
    showToast('No duplicate details available', 'info');
    return;
  }

  const content = `
        <div class="duplicate-list">
            ${duplicatesData
              .map(
                (dup) => `
                <div class="duplicate-item">
                    <h4>${dup.ticker} - ${dup.shares.toFixed(6)} shares</h4>
                    <p>${dup.reason}</p>
                    <div class="positions">
                        ${dup.positions
                          .map(
                            (pos) => `
                            <div class="position-chip">
                                <span class="account">${pos.account_name}</span>
                                <span>${formatCurrency(pos.value)}</span>
                                <span class="delete-btn" onclick="deleteDuplicatePosition('${
                                  pos.id
                                }')" title="Delete this position">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                    </svg>
                                </span>
                            </div>
                        `
                          )
                          .join('')}
                    </div>
                </div>
            `
              )
              .join('')}
        </div>
        <p style="margin-top: 16px; font-size: 12px; color: var(--color-text-tertiary);">
            Click the delete icon next to a position to remove it. Usually you want to keep one and remove the duplicate.
        </p>
    `;

  showModal('Potential Duplicates', content);
}

async function deleteDuplicatePosition(positionId) {
  if (!confirm('Are you sure you want to delete this position?')) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/portfolio/positions/${positionId}`, {
      method: 'DELETE',
    });

    if (response.ok) {
      showToast('Position deleted', 'success');
      closeModal();
      loadData(); // Refresh all data
    } else {
      showToast('Failed to delete position', 'error');
    }
  } catch (error) {
    console.error('Error deleting position:', error);
    showToast('Error deleting position', 'error');
  }
}

function updateAccountTotalsTable(accounts) {
  const tbody = document.getElementById('account-totals-body');
  const sumEl = document.getElementById('account-totals-sum');

  if (!tbody || !accounts || accounts.length === 0) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center">No accounts</td></tr>';
    return;
  }

  // Sort by value descending
  const sortedAccounts = [...accounts].sort((a, b) => b.value - a.value);
  const total = sortedAccounts.reduce((sum, acc) => sum + acc.value, 0);

  tbody.innerHTML = sortedAccounts
    .map((acc) => {
      const pct = total > 0 ? (acc.value / total) * 100 : 0;
      const typeClass = acc.is_retirement ? 'type-retirement' : 'type-taxable';

      return `
            <tr>
                <td><strong>${acc.name}</strong></td>
                <td><span class="account-type-badge ${typeClass}">${acc.display_type}</span></td>
                <td class="text-right">${formatCurrency(acc.value)}</td>
                <td class="text-right">${pct.toFixed(1)}%</td>
            </tr>
        `;
    })
    .join('');

  if (sumEl) {
    sumEl.textContent = formatCurrency(total);
  }
}

function updateAccountFilter(positions) {
  const accounts = [...new Set(positions.map((p) => p.account))].sort();
  const optionsContainer = document.getElementById('account-filter-options');

  // Preserve current selection
  const currentSelection = new Set(selectedAccounts);

  optionsContainer.innerHTML = accounts
    .map(
      (acc) => `
        <div class="multi-select-option">
            <input type="checkbox" id="acc-${acc.replace(/\s+/g, '-')}" value="${acc}"
                   ${currentSelection.size === 0 || currentSelection.has(acc) ? 'checked' : ''}
                   onchange="handleAccountFilterChange()">
            <label for="acc-${acc.replace(/\s+/g, '-')}">${acc}</label>
        </div>
    `
    )
    .join('');

  // Initialize selectedAccounts if empty (select all by default)
  if (selectedAccounts.size === 0) {
    selectedAccounts = new Set(accounts);
  }

  updateAccountFilterLabel();
}

function handleAccountFilterChange() {
  const checkboxes = document.querySelectorAll('#account-filter-options input[type="checkbox"]');
  selectedAccounts = new Set();
  checkboxes.forEach((cb) => {
    if (cb.checked) {
      selectedAccounts.add(cb.value);
    }
  });
  updateAccountFilterLabel();
  filterHoldings();
}

function updateAccountFilterLabel() {
  const label = document.getElementById('account-filter-label');
  const checkboxes = document.querySelectorAll('#account-filter-options input[type="checkbox"]');
  const total = checkboxes.length;
  const selected = selectedAccounts.size;

  if (selected === 0 || selected === total) {
    label.innerHTML = 'All Accounts';
  } else if (selected === 1) {
    label.innerHTML = [...selectedAccounts][0];
  } else {
    label.innerHTML = `${selected} accounts`;
  }
}

function toggleMultiSelect(dropdownId) {
  const dropdown = document.getElementById(dropdownId);
  const wasOpen = dropdown.classList.contains('open');

  // Close all dropdowns first
  document.querySelectorAll('.multi-select-dropdown.open').forEach((d) => {
    d.classList.remove('open');
  });

  // Toggle this one
  if (!wasOpen) {
    dropdown.classList.add('open');
  }
}

function selectAllAccounts(selectAll) {
  const checkboxes = document.querySelectorAll('#account-filter-options input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = selectAll;
  });
  handleAccountFilterChange();
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.multi-select-dropdown')) {
    document.querySelectorAll('.multi-select-dropdown.open').forEach((d) => {
      d.classList.remove('open');
    });
  }
});

function updateHoldings(positions) {
  const tbody = document.querySelector('#holdings-table tbody');
  tbody.innerHTML = '';

  // Apply sorting
  const sorted = sortPositions(positions, currentSort.field, currentSort.direction);

  // Apply filters
  const filtered = filterPositionsList(sorted);

  filtered.forEach((pos) => {
    const gainLoss = pos.cost_basis ? pos.value - pos.cost_basis : null;
    const gainLossPct = pos.cost_basis ? ((pos.value - pos.cost_basis) / pos.cost_basis) * 100 : null;

    // Format value with APY indicator for interest-bearing positions
    let valueDisplay = formatCurrency(pos.value);
    if (pos.interest_rate && pos.interest_rate > 0) {
      const apyPct = (pos.interest_rate * 100).toFixed(2);
      valueDisplay = `<span title="Includes accrued interest at ${apyPct}% APY">${formatCurrency(pos.value)} 📈</span>`;
    }

    // For real estate: Price = purchase price (cost_basis), Value = current value
    // For stocks/funds: Price = share price, Value = shares * price
    const isRealEstate = pos.position_type === 'real_estate';
    let priceDisplay;
    if (isRealEstate) {
      // Real estate: show purchase price in Price column
      priceDisplay = pos.cost_basis ? formatCurrency(pos.cost_basis) : '<span class="text-warning">$0.00</span>';
    } else {
      priceDisplay = pos.price ? formatPrice(pos.price, pos.ticker) : '<span class="text-warning">$0.00</span>';
    }

    const row = document.createElement('tr');
    row.dataset.account = pos.account;
    row.innerHTML = `
            <td><strong>${pos.ticker}</strong></td>
            <td>${pos.name || '-'}</td>
            <td>${pos.account}</td>
            <td class="text-right">${formatShares(pos.shares)}</td>
            <td class="text-right">${priceDisplay}</td>
            <td class="text-right">${valueDisplay}</td>
            <td class="text-right ${gainLoss >= 0 ? 'text-success' : 'text-error'}">
                ${gainLoss !== null ? `${formatCurrency(gainLoss)} (${formatPercent(gainLossPct)})` : '-'}
            </td>
            <td>
                <div class="actions-dropdown">
                    <button class="actions-btn" onclick="toggleActionsMenu(this)">
                        Actions <span>▼</span>
                    </button>
                    <div class="actions-menu">
                        <button onclick="showEditPositionModal('${pos.id}', '${pos.ticker}', ${pos.shares}, ${
      pos.price || 0
    }, ${pos.cost_basis || 0}, '${pos.position_type || 'equity'}', ${pos.interest_rate || 'null'}, '${
      pos.purchase_date || ''
    }', '${pos.maturity_date || ''}')">
                            ✏️ Edit
                        </button>
                        <button class="danger" onclick="deletePosition('${pos.id}')">
                            🗑️ Delete
                        </button>
                    </div>
                </div>
            </td>
        `;
    tbody.appendChild(row);
  });

  // Update sort indicators
  updateSortIndicators();
}

function sortPositions(positions, field, direction) {
  return [...positions].sort((a, b) => {
    let aVal, bVal;

    switch (field) {
      case 'ticker':
        aVal = a.ticker;
        bVal = b.ticker;
        break;
      case 'name':
        aVal = a.name || '';
        bVal = b.name || '';
        break;
      case 'account':
        aVal = a.account;
        bVal = b.account;
        break;
      case 'shares':
        aVal = a.shares;
        bVal = b.shares;
        break;
      case 'price':
        aVal = a.price || 0;
        bVal = b.price || 0;
        break;
      case 'value':
        aVal = a.value || 0;
        bVal = b.value || 0;
        break;
      case 'gain_loss':
        aVal = a.cost_basis ? a.value - a.cost_basis : -Infinity;
        bVal = b.cost_basis ? b.value - b.cost_basis : -Infinity;
        break;
      default:
        aVal = a.value || 0;
        bVal = b.value || 0;
    }

    if (typeof aVal === 'string') {
      return direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return direction === 'asc' ? aVal - bVal : bVal - aVal;
  });
}

function sortHoldings(field) {
  if (currentSort.field === field) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.field = field;
    currentSort.direction = 'desc';
  }
  updateHoldings(currentPositions);
}

function updateSortIndicators() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === currentSort.field) {
      th.classList.add(`sort-${currentSort.direction}`);
    }
  });
}

function filterPositionsList(positions) {
  const search = document.getElementById('holdings-search').value.toLowerCase();

  return positions.filter((pos) => {
    // Search filter
    const searchMatch =
      !search ||
      pos.ticker.toLowerCase().includes(search) ||
      (pos.name && pos.name.toLowerCase().includes(search)) ||
      pos.account.toLowerCase().includes(search);

    // Account filter using the selectedAccounts Set (if empty, show all)
    const accountMatch = selectedAccounts.size === 0 || selectedAccounts.has(pos.account);

    return searchMatch && accountMatch;
  });
}

function filterHoldings() {
  updateHoldings(currentPositions);
}

function toggleActionsMenu(btn) {
  const dropdown = btn.closest('.actions-dropdown');
  dropdown.classList.toggle('open');

  // Close when clicking outside
  const closeMenu = (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

async function deletePosition(positionId) {
  if (!confirm('Are you sure you want to delete this position?')) return;

  try {
    await fetch(`${API_BASE}/api/portfolio/positions/${positionId}`, {
      method: 'DELETE',
    });
    showToast('Position deleted', 'success');
    refreshData();
  } catch (error) {
    showToast('Failed to delete position', 'error');
  }
}

// Edit Position Modal
function showEditPositionModal(
  id,
  ticker,
  shares,
  price,
  costBasis,
  positionType,
  interestRate,
  purchaseDate,
  maturityDate
) {
  document.getElementById('edit-position-id').value = id;
  document.getElementById('edit-position-type').value = positionType || 'equity';
  document.getElementById('edit-position-ticker').value = ticker;
  document.getElementById('edit-position-shares').value = shares;
  document.getElementById('edit-position-price').value = price || '';
  document.getElementById('edit-position-cost-basis').value = costBasis || '';

  // Handle interest/APY fields for cash, CD, bond positions
  const interestFields = document.getElementById('edit-interest-fields');
  const showInterestFields = ['cash', 'cd', 'bond', 'treasury'].includes(positionType);
  interestFields.style.display = showInterestFields ? 'block' : 'none';

  if (showInterestFields) {
    // Convert decimal APY to percentage for display
    document.getElementById('edit-position-apy').value = interestRate ? (interestRate * 100).toFixed(2) : '';
    document.getElementById('edit-position-purchase-date').value = purchaseDate || '';
    document.getElementById('edit-position-maturity-date').value = maturityDate || '';
  }

  document.getElementById('edit-position-modal').style.display = 'flex';
}

function hideEditPositionModal() {
  document.getElementById('edit-position-modal').style.display = 'none';
}

async function updatePosition(event) {
  event.preventDefault();

  const positionId = document.getElementById('edit-position-id').value;
  const positionType = document.getElementById('edit-position-type').value;
  const shares = parseFloat(document.getElementById('edit-position-shares').value);
  const price = document.getElementById('edit-position-price').value;
  const costBasis = document.getElementById('edit-position-cost-basis').value;

  const data = { shares };
  if (price) data.current_price = parseFloat(price);
  if (costBasis) data.cost_basis = parseFloat(costBasis);

  // Include interest fields for cash/CD/bond positions
  if (['cash', 'cd', 'bond', 'treasury'].includes(positionType)) {
    const apyValue = document.getElementById('edit-position-apy').value;
    const purchaseDate = document.getElementById('edit-position-purchase-date').value;
    const maturityDate = document.getElementById('edit-position-maturity-date').value;

    if (apyValue) data.interest_rate = parseFloat(apyValue) / 100;
    if (purchaseDate) data.purchase_date = purchaseDate;
    if (maturityDate) data.maturity_date = maturityDate;
  }

  try {
    await fetch(`${API_BASE}/api/portfolio/positions/${positionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    showToast('Position updated', 'success');
    hideEditPositionModal();
    refreshData();
  } catch (error) {
    showToast('Failed to update position', 'error');
  }
}

// Common Plotly config - disable modebar to remove "Edit in Chart Studio" link
const plotlyConfig = {
  responsive: true,
  displayModeBar: false, // Hide the modebar entirely
  staticPlot: false, // Still allow hover interactions
};

function updateAllocationCharts(positions, summary) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const chartLayout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
    margin: { t: 10, b: 10, l: 10, r: 10 },
    showlegend: false, // Hidden - percentages shown on chart, hover for details
    hoverlabel: {
      bgcolor: isDark ? '#1f1f1f' : 'white',
      bordercolor: isDark ? '#424242' : '#d9d9d9',
      font: { color: isDark ? 'white' : 'black' },
    },
  };

  // Account type allocation
  const accountAlloc = {};
  positions.forEach((pos) => {
    const type = pos.account_type || 'unknown';
    accountAlloc[type] = (accountAlloc[type] || 0) + (pos.value || 0);
  });

  const accountLabels = Object.keys(accountAlloc).map((k) =>
    k.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  );
  const accountValues = Object.values(accountAlloc);

  Plotly.newPlot(
    'chart-account-type',
    [
      {
        type: 'pie',
        labels: accountLabels,
        values: accountValues,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'inside',
        insidetextorientation: 'horizontal',
        hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>',
        marker: {
          colors: ['#1668dc', '#49aa19', '#9254de', '#d87a16', '#13a8a8', '#dc4446'],
        },
      },
    ],
    chartLayout,
    plotlyConfig
  );

  // Ticker allocation (top 10)
  const tickerAlloc = {};
  positions.forEach((pos) => {
    tickerAlloc[pos.ticker] = (tickerAlloc[pos.ticker] || 0) + (pos.value || 0);
  });

  const sortedTickers = Object.entries(tickerAlloc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const otherValue =
    Object.values(tickerAlloc).reduce((a, b) => a + b, 0) - sortedTickers.reduce((a, b) => a + b[1], 0);

  const allocLabels = sortedTickers.map((t) => t[0]);
  const allocValues = sortedTickers.map((t) => t[1]);

  if (otherValue > 0) {
    allocLabels.push('Other');
    allocValues.push(otherValue);
  }

  Plotly.newPlot(
    'chart-allocation',
    [
      {
        type: 'pie',
        labels: allocLabels,
        values: allocValues,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'inside',
        insidetextorientation: 'horizontal',
        hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>',
      },
    ],
    chartLayout,
    plotlyConfig
  );
}

function updateHistoryChart(history, storeData = true) {
  const container = document.getElementById('chart-history');

  // Store full history data for time range filtering
  if (storeData && history) {
    fullHistoryData = history;
  }

  if (!history || history.length === 0) {
    container.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">No history data yet</p>';
    return;
  }

  // Filter history based on selected time range
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - currentHistoryDays);
  const filteredHistory = history.filter(h => new Date(h.date) >= cutoffDate);

  if (filteredHistory.length === 0) {
    container.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">No data for selected time range</p>';
    return;
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const dates = filteredHistory.map((h) => h.date);
  const totals = filteredHistory.map((h) => h.total);
  const retirement = filteredHistory.map((h) => h.retirement);
  const taxable = filteredHistory.map((h) => h.taxable);

  Plotly.newPlot(
    'chart-history',
    [
      {
        x: dates,
        y: totals,
        type: 'scatter',
        mode: 'lines',
        name: 'Total',
        line: { color: '#1668dc', width: 2 },
      },
      {
        x: dates,
        y: retirement,
        type: 'scatter',
        mode: 'lines',
        name: 'Retirement',
        line: { color: '#49aa19', width: 1 },
      },
      {
        x: dates,
        y: taxable,
        type: 'scatter',
        mode: 'lines',
        name: 'Taxable',
        line: { color: '#d87a16', width: 1 },
      },
    ],
    {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
      margin: { t: 20, b: 40, l: 70, r: 20 },
      xaxis: {
        gridcolor: isDark ? '#303030' : '#f0f0f0',
      },
      yaxis: {
        title: '',
        tickformat: '$,.0f',
        gridcolor: isDark ? '#303030' : '#f0f0f0',
      },
      legend: { orientation: 'h', y: 1.1 },
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor: isDark ? '#1f1f1f' : 'white',
        bordercolor: isDark ? '#424242' : '#d9d9d9',
        font: { color: isDark ? 'white' : 'black' },
      },
    },
    plotlyConfig
  );
}

function setHistoryTimeRange(days) {
  currentHistoryDays = days;

  // Update button states
  document.querySelectorAll('.time-range-btn').forEach(btn => {
    btn.classList.remove('active');
    if (parseInt(btn.dataset.days) === days) {
      btn.classList.add('active');
    }
  });

  // Re-render chart with filtered data
  updateHistoryChart(fullHistoryData, false);
}

// Analysis data
let currentAllocationTab = 'asset-class';
let triggersData = [];

async function loadAnalysisData() {
  showLoading('Loading analysis data...');
  try {
    const [perfResp, riskResp, allocResp, detailedResp, triggeredResp] = await Promise.all([
      fetch(`${API_BASE}/api/analysis/performance`),
      fetch(`${API_BASE}/api/analysis/risk`),
      fetch(`${API_BASE}/api/analysis/allocation`),
      fetch(`${API_BASE}/api/analysis/allocation/detailed`),
      fetch(`${API_BASE}/api/analysis/triggers/triggered`),
    ]);

    const [perf, risk, alloc, detailed, triggered] = await Promise.all([
      perfResp.json(),
      riskResp.json(),
      allocResp.json(),
      detailedResp.json(),
      triggeredResp.json(),
    ]);

    // Update performance metrics
    document.getElementById('ytd-return').textContent = formatPercent(perf.ytd_return);
    document.getElementById('one-year-return').textContent = formatPercent(perf.one_year_return);
    document.getElementById('alpha-ytd').textContent = formatPercent(perf.alpha_ytd);
    document.getElementById('benchmark-ytd').textContent = formatPercent(perf.benchmark_ytd);

    // Update risk metrics
    document.getElementById('volatility').textContent = formatPercent(risk.volatility);
    document.getElementById('sharpe-ratio').textContent = formatNumber(risk.sharpe_ratio);
    document.getElementById('max-drawdown').textContent = formatPercent(-Math.abs(risk.max_drawdown));
    document.getElementById('beta').textContent = formatNumber(risk.beta);
    document.getElementById('var-95').textContent = formatPercent(risk.var_95);

    // Update concentration
    document.getElementById('concentration-top5').textContent = formatPercent(alloc.concentration_top5);
    document.getElementById('concentration-top10').textContent = formatPercent(alloc.concentration_top10);
    document.getElementById('cash-allocation').textContent = formatPercent(detailed.cash_allocation);
    document.getElementById('invested-allocation').textContent = formatPercent(detailed.invested_allocation);

    // Store detailed data for tab switching
    window.detailedAllocation = detailed;

    // Render allocation table for current tab
    renderAllocationTable(currentAllocationTab);

    // Render top holdings
    renderTopHoldings();

    // Render triggered alerts
    renderTriggeredAlerts(triggered);

    // Check Claude API status
    checkClaudeStatus();

    // Auto-load plugin insights and widgets
    loadPluginAnalysis();
    loadWidgets();
  } catch (error) {
    console.error('Error loading analysis data:', error);
  } finally {
    hideLoading();
  }
}

function showAllocationTab(tab) {
  currentAllocationTab = tab;

  // Update tab buttons
  document.querySelectorAll('.alloc-tab').forEach((btn) => {
    btn.classList.remove('active');
    const btnText = btn.textContent.toLowerCase().replace(/ /g, '-');
    if (
      btnText === tab ||
      (btn.textContent === 'Asset Class' && tab === 'asset-class') ||
      (btn.textContent === 'Position Type' && tab === 'position-type') ||
      (btn.textContent === 'Market Cap' && tab === 'cap')
    ) {
      btn.classList.add('active');
    }
  });

  renderAllocationTable(tab);
}

function renderAllocationTable(tab) {
  const data = window.detailedAllocation;
  if (!data) return;

  let rows = [];
  switch (tab) {
    case 'asset-class':
      rows = data.by_asset_class || [];
      break;
    case 'position-type':
      rows = data.by_position_type || [];
      break;
    case 'sector':
      rows = data.by_sector || [];
      break;
    case 'geography':
      rows = data.by_geography || [];
      break;
    case 'cap':
      rows = data.by_cap || [];
      break;
    case 'style':
      rows = data.by_style || [];
      break;
  }

  const tbody = document.querySelector('#allocation-table tbody');
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="text-muted">No data available. Ensure funds are defined in funds.yaml with allocation percentages.</td></tr>';
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
            <td>${row.name}</td>
            <td class="text-right">${formatCurrency(row.total)}</td>
            <td class="text-right">${row.current_pct.toFixed(2)}%</td>
        `;
    tbody.appendChild(tr);
  });
}

function renderTopHoldings() {
  const container = document.getElementById('top-holdings-list');
  if (!currentPositions || currentPositions.length === 0) {
    container.innerHTML = '<p class="text-muted">No holdings data</p>';
    return;
  }

  // Aggregate by ticker and sort by value
  const tickerValues = {};
  currentPositions.forEach((pos) => {
    const ticker = pos.ticker;
    tickerValues[ticker] = (tickerValues[ticker] || 0) + (pos.value || 0);
  });

  const sorted = Object.entries(tickerValues)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const totalValue = Object.values(tickerValues).reduce((a, b) => a + b, 0);

  container.innerHTML = sorted
    .map(([ticker, value]) => {
      const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
      return `
            <div class="holding-item">
                <span class="holding-ticker">${ticker}</span>
                <span class="holding-value">${formatCurrency(value)} <span class="holding-pct">(${pct.toFixed(
        1
      )}%)</span></span>
            </div>
        `;
    })
    .join('');
}

function renderTriggeredAlerts(triggered) {
  const container = document.getElementById('alerts-list');

  if (!triggered || triggered.length === 0) {
    container.innerHTML =
      '<p class="text-muted">No alerts triggered. Add alerts to monitor your portfolio conditions.</p>';
    return;
  }

  container.innerHTML = triggered
    .map(
      (alert) => `
        <div class="alert-item ${alert.triggered ? 'triggered' : ''}">
            <div class="alert-icon">${alert.triggered ? '⚠️' : '✓'}</div>
            <div class="alert-content">
                <div class="alert-name">${alert.trigger_name}</div>
                <div class="alert-message">${alert.message}</div>
            </div>
            <div class="alert-value">
                Current: ${formatNumber(alert.current_value, 2)} ${alert.operator} ${alert.threshold}
            </div>
        </div>
    `
    )
    .join('');
}

// Metric Detail Modal Functions
// Note: Data displayed is from user's local portfolio - this is a local-only application
const metricExplanations = {
  'ytd-return': {
    title: 'Year-to-Date Return',
    explanation:
      '<strong>YTD Return</strong> measures how much your portfolio has grown since January 1st of this year. ' +
      "It is calculated as the weighted average of each position's YTD performance based on current portfolio weights. " +
      'A positive value means your portfolio has gained value this year, while negative means a decline.',
  },
  'one-year-return': {
    title: '1-Year Return',
    explanation:
      "<strong>1-Year Return</strong> (also called trailing twelve months or TTM) shows your portfolio's " +
      'performance over the past 12 months. This is a rolling period that updates daily, providing a longer-term view ' +
      'of performance compared to YTD.',
  },
  alpha: {
    title: 'Alpha vs S&P 500',
    explanation:
      '<strong>Alpha</strong> measures how much your portfolio has outperformed (positive) or underperformed ' +
      '(negative) compared to the S&P 500 benchmark. An alpha of +2% means you beat the market by 2 percentage points. ' +
      'This is a key measure of whether active management or stock picking is adding value.',
  },
  volatility: {
    title: 'Volatility (Annual)',
    explanation:
      "<strong>Volatility</strong> measures the standard deviation of your portfolio's daily returns, " +
      'annualized to show what you might expect over a year. Higher volatility means more dramatic price swings. ' +
      '<br><br>Typical ranges: Low-risk portfolio: 5-10%, Balanced: 10-15%, Aggressive: 15-25%+',
  },
  sharpe: {
    title: 'Sharpe Ratio',
    explanation:
      "<strong>Sharpe Ratio</strong> measures risk-adjusted returns - how much return you're getting per unit " +
      'of risk taken. It is calculated as (Portfolio Return - Risk-Free Rate) / Volatility. ' +
      '<br><br>Interpretation: &lt; 1.0 = Below average, 1.0-2.0 = Good, &gt; 2.0 = Excellent',
  },
  'max-drawdown': {
    title: 'Maximum Drawdown',
    explanation:
      "<strong>Max Drawdown</strong> shows the largest peak-to-trough decline in your portfolio's value " +
      'over the past year. This represents the worst-case scenario an investor would have experienced. ' +
      '<br><br>For example, -20% means at some point the portfolio dropped 20% from its previous high.',
  },
  beta: {
    title: 'Portfolio Beta',
    explanation:
      "<strong>Beta</strong> measures your portfolio's sensitivity to market movements. A beta of 1.0 " +
      'means your portfolio moves in line with the market. ' +
      '<br><br>Beta &gt; 1.0: More volatile than market, amplifies gains/losses<br>' +
      'Beta &lt; 1.0: Less volatile, dampens market swings<br>' +
      'Beta = 0: No correlation to market',
  },
  var: {
    title: 'Value at Risk (95%)',
    explanation:
      '<strong>VaR 95%</strong> estimates the maximum daily loss you could expect 95% of the time. ' +
      'In other words, losses exceeding this amount should only occur about 1 in 20 trading days. ' +
      '<br><br>For example, VaR of 2.5% on a $1M portfolio means daily losses should stay under $25,000 ' +
      'about 95% of the time.',
  },
};

function showMetricDetail(metricId) {
  const metric = metricExplanations[metricId];
  if (!metric) {
    showToast('Details not available for this metric', 'info');
    return;
  }

  const content =
    '<div class="metric-explanation">' +
    metric.explanation +
    '</div>' +
    '<p style="font-size: 12px; color: var(--color-text-tertiary); margin-top: 16px;">' +
    'Note: Metrics are calculated using historical price data from the past year. ' +
    'Results may vary with different time periods.</p>';

  showModal(metric.title, content);
}

function showTopHoldingsDetail(count) {
  if (!currentPositions || currentPositions.length === 0) {
    showToast('No holdings data available', 'info');
    return;
  }

  // Aggregate by ticker
  const tickerData = {};
  currentPositions.forEach((pos) => {
    const ticker = pos.ticker;
    if (!tickerData[ticker]) {
      tickerData[ticker] = {
        ticker: ticker,
        name: pos.name || ticker,
        shares: 0,
        value: 0,
        accounts: [],
      };
    }
    tickerData[ticker].shares += pos.shares || 0;
    tickerData[ticker].value += pos.value || 0;
    if (pos.account_name && !tickerData[ticker].accounts.includes(pos.account_name)) {
      tickerData[ticker].accounts.push(pos.account_name);
    }
  });

  const sorted = Object.values(tickerData)
    .sort((a, b) => b.value - a.value)
    .slice(0, count);

  const totalValue = Object.values(tickerData).reduce((sum, p) => sum + p.value, 0);
  const topValue = sorted.reduce((sum, p) => sum + p.value, 0);
  const topPct = totalValue > 0 ? (topValue / totalValue) * 100 : 0;

  // Build table rows - data is from user's local portfolio
  const tableRows = sorted
    .map((pos, idx) => {
      const pct = totalValue > 0 ? (pos.value / totalValue) * 100 : 0;
      return (
        '<tr>' +
        '<td>' +
        (idx + 1) +
        '</td>' +
        '<td><strong>' +
        escapeHtml(pos.ticker) +
        '</strong></td>' +
        '<td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">' +
        escapeHtml(pos.name) +
        '</td>' +
        '<td class="text-right">' +
        formatShares(pos.shares) +
        '</td>' +
        '<td class="text-right">' +
        formatCurrency(pos.value) +
        '</td>' +
        '<td class="text-right">' +
        pct.toFixed(2) +
        '%</td>' +
        '</tr>'
      );
    })
    .join('');

  const content =
    '<div class="detail-summary">' +
    '<div class="detail-summary-item">' +
    '<div class="detail-summary-label">Top ' +
    count +
    ' Value</div>' +
    '<div class="detail-summary-value">' +
    formatCurrency(topValue) +
    '</div>' +
    '</div>' +
    '<div class="detail-summary-item">' +
    '<div class="detail-summary-label">% of Portfolio</div>' +
    '<div class="detail-summary-value">' +
    topPct.toFixed(1) +
    '%</div>' +
    '</div>' +
    '<div class="detail-summary-item">' +
    '<div class="detail-summary-label">Total Portfolio</div>' +
    '<div class="detail-summary-value">' +
    formatCurrency(totalValue) +
    '</div>' +
    '</div>' +
    '</div>' +
    '<table class="detail-table">' +
    '<thead><tr>' +
    '<th>#</th><th>Ticker</th><th>Name</th>' +
    '<th class="text-right">Shares</th><th class="text-right">Value</th><th class="text-right">% of Portfolio</th>' +
    '</tr></thead>' +
    '<tbody>' +
    tableRows +
    '</tbody>' +
    '</table>';

  showModal('Top ' + count + ' Holdings', content);
}

function showCashDetail() {
  if (!currentPositions || currentPositions.length === 0) {
    showToast('No holdings data available', 'info');
    return;
  }

  // Find all cash-like positions
  const cashPositions = currentPositions.filter((pos) => {
    const ticker = (pos.ticker || '').toUpperCase();
    const posType = (pos.position_type || '').toLowerCase();
    return (
      ticker === 'CASH' ||
      ticker.includes('MONEY MARKET') ||
      ticker.includes('MMKT') ||
      posType === 'cash' ||
      posType === 'cd'
    );
  });

  const totalValue = currentPositions.reduce((sum, p) => sum + (p.value || 0), 0);
  const cashValue = cashPositions.reduce((sum, p) => sum + (p.value || 0), 0);
  const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : 0;

  let content = '';

  if (cashPositions.length === 0) {
    content =
      '<div class="metric-explanation">' +
      '<strong>No cash positions found.</strong><br><br>' +
      'Cash positions include: Money market funds, bank sweep accounts, and CDs. ' +
      'Your portfolio appears to be fully invested in securities.' +
      '</div>';
  } else {
    const tableRows = cashPositions
      .map(
        (pos) =>
          '<tr>' +
          '<td>' +
          escapeHtml(pos.account_name || '-') +
          '</td>' +
          '<td>' +
          escapeHtml(pos.name || pos.ticker || 'Cash') +
          '</td>' +
          '<td class="text-right">' +
          formatCurrency(pos.value) +
          '</td>' +
          '</tr>'
      )
      .join('');

    content =
      '<div class="detail-summary">' +
      '<div class="detail-summary-item">' +
      '<div class="detail-summary-label">Total Cash</div>' +
      '<div class="detail-summary-value">' +
      formatCurrency(cashValue) +
      '</div>' +
      '</div>' +
      '<div class="detail-summary-item">' +
      '<div class="detail-summary-label">% of Portfolio</div>' +
      '<div class="detail-summary-value">' +
      cashPct.toFixed(1) +
      '%</div>' +
      '</div>' +
      '</div>' +
      '<table class="detail-table">' +
      '<thead><tr><th>Account</th><th>Type</th><th class="text-right">Value</th></tr></thead>' +
      '<tbody>' +
      tableRows +
      '</tbody>' +
      '</table>';
  }

  showModal('Cash Allocation Details', content);
}

// Helper function to escape HTML for safe display
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Trigger Modal Functions
async function showAddTriggerModal() {
  // Load trigger types
  try {
    const resp = await fetch(`${API_BASE}/api/analysis/triggers/types`);
    const data = await resp.json();

    // Populate condition type dropdown
    const typeSelect = document.getElementById('trigger-condition-type');
    typeSelect.innerHTML = Object.entries(data.condition_types)
      .map(([value, desc]) => `<option value="${value}">${desc}</option>`)
      .join('');

    // Populate operator dropdown
    const opSelect = document.getElementById('trigger-operator');
    opSelect.innerHTML = data.operators.map((op) => `<option value="${op}">${op}</option>`).join('');

    document.getElementById('add-trigger-modal').style.display = 'flex';
  } catch (error) {
    console.error('Error loading trigger types:', error);
    showToast('Failed to load trigger options', 'error');
  }
}

function hideAddTriggerModal() {
  document.getElementById('add-trigger-modal').style.display = 'none';
  document.getElementById('add-trigger-form').reset();
}

async function createTrigger(event) {
  event.preventDefault();

  const data = {
    name: document.getElementById('trigger-name').value,
    condition_type: document.getElementById('trigger-condition-type').value,
    operator: document.getElementById('trigger-operator').value,
    threshold: parseFloat(document.getElementById('trigger-threshold').value),
    ticker: document.getElementById('trigger-ticker').value || null,
  };

  try {
    const resp = await fetch(`${API_BASE}/api/analysis/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (resp.ok) {
      showToast('Alert created', 'success');
      hideAddTriggerModal();
      loadAnalysisData();
    } else {
      const error = await resp.json();
      showToast(`Error: ${error.detail}`, 'error');
    }
  } catch (error) {
    showToast('Failed to create alert', 'error');
  }
}

async function deleteTrigger(triggerId) {
  if (!confirm('Delete this alert?')) return;

  try {
    await fetch(`${API_BASE}/api/analysis/triggers/${triggerId}`, {
      method: 'DELETE',
    });
    showToast('Alert deleted', 'success');
    loadAnalysisData();
  } catch (error) {
    showToast('Failed to delete alert', 'error');
  }
}

// Claude API / Fund Analysis Functions
async function checkClaudeStatus() {
  try {
    const resp = await fetch(`${API_BASE}/api/analysis/fund/status`);
    const status = await resp.json();

    const badge = document.getElementById('claude-status-badge');
    const featureStatus = document.getElementById('claude-feature-status');

    if (status.claude_available) {
      badge.textContent = 'AI Enabled';
      badge.className = 'status-badge enabled';
      featureStatus.textContent = `(API Key: ${status.api_key_source})`;
    } else {
      badge.textContent = 'AI Disabled';
      badge.className = 'status-badge disabled';
      featureStatus.textContent = '(Add API key in Settings to enable AI analysis)';
    }
  } catch (error) {
    console.error('Error checking Claude status:', error);
  }
}

async function analyzeFund() {
  const ticker = document.getElementById('analyze-ticker').value.trim().toUpperCase();
  if (!ticker) {
    showToast('Please enter a fund ticker', 'error');
    return;
  }

  showLoading(`Analyzing ${ticker}...`);

  try {
    const resp = await fetch(`${API_BASE}/api/analysis/fund/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, use_claude: true }),
    });

    if (!resp.ok) {
      const error = await resp.json();
      showToast(`Error: ${error.detail}`, 'error');
      return;
    }

    const result = await resp.json();
    displayFundAnalysis(result);
    showToast(`Analysis complete (source: ${result.data_source})`, 'success');
  } catch (error) {
    showToast('Failed to analyze fund', 'error');
  } finally {
    hideLoading();
  }
}

function displayFundAnalysis(result) {
  document.getElementById('fund-analysis-result').style.display = 'block';

  document.getElementById('fa-ticker').textContent = result.ticker;
  document.getElementById('fa-name').textContent = result.name || '-';
  document.getElementById('fa-category').textContent = result.morningstar_category || '-';
  document.getElementById('fa-style').textContent = result.style
    ? result.style.charAt(0).toUpperCase() + result.style.slice(1)
    : '-';
  document.getElementById('fa-cap').textContent = result.market_cap
    ? result.market_cap.charAt(0).toUpperCase() + result.market_cap.slice(1)
    : '-';
  document.getElementById('fa-region').textContent = result.region
    ? result.region.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase())
    : '-';

  // Show data source with icon
  const sourceEl = document.getElementById('fa-source');
  if (result.data_source === 'claude') {
    sourceEl.innerHTML = '🤖 Claude AI';
  } else if (result.data_source === 'cache') {
    sourceEl.innerHTML = '💾 Cached';
  } else {
    sourceEl.innerHTML = '📊 yfinance';
  }

  // Show sector breakdown if available
  const sectorsContainer = document.getElementById('fa-sectors');
  const sectorsList = document.getElementById('fa-sectors-list');

  if (result.sector_breakdown && Object.keys(result.sector_breakdown).length > 0) {
    sectorsContainer.style.display = 'block';

    const sortedSectors = Object.entries(result.sector_breakdown).sort((a, b) => b[1] - a[1]);

    sectorsList.innerHTML = sortedSectors
      .map(
        ([sector, pct]) => `
            <div class="holding-item">
                <span class="holding-ticker">${sector}</span>
                <span class="holding-value">${pct.toFixed(1)}%</span>
            </div>
        `
      )
      .join('');
  } else {
    sectorsContainer.style.display = 'none';
  }
}

async function analyzePortfolioFunds() {
  showLoading('Analyzing portfolio funds...');

  try {
    const resp = await fetch(`${API_BASE}/api/analysis/fund/analyze-portfolio`, {
      method: 'POST',
    });

    const result = await resp.json();

    if (result.analyzed && result.analyzed.length > 0) {
      showToast(`Analyzed ${result.analyzed.length} of ${result.total_funds} funds`, 'success');

      // Display the first result
      if (result.analyzed[0] && !result.analyzed[0].error) {
        displayFundAnalysis(result.analyzed[0]);
      }
    } else {
      showToast(result.message || 'No funds found to analyze', 'info');
    }
  } catch (error) {
    showToast('Failed to analyze portfolio funds', 'error');
  } finally {
    hideLoading();
  }
}

async function updatePositionSectors() {
  showLoading('Updating position sectors...');

  try {
    const resp = await fetch(`${API_BASE}/api/analysis/positions/update-sectors`, {
      method: 'POST',
    });

    const result = await resp.json();

    if (result.error) {
      showToast(result.error, 'error');
      return;
    }

    if (result.positions_updated > 0) {
      showToast(`Updated sectors for ${result.positions_updated} positions`, 'success');
      // Refresh the page to show updated sectors
      window.location.reload();
    } else if (result.message) {
      showToast(result.message, 'info');
    } else {
      showToast(`Analyzed ${result.total_tickers} tickers`, 'info');
    }
  } catch (error) {
    console.error('Error updating sectors:', error);
    showToast('Failed to update position sectors', 'error');
  } finally {
    hideLoading();
  }
}

// Advisor Analysis (Enhanced with portfolio context)
async function getAdvisorAnalysis() {
  const ticker = document.getElementById('analyze-ticker').value.trim().toUpperCase();
  if (!ticker) {
    showToast('Please enter a fund ticker', 'error');
    return;
  }

  showLoading(`Getting advisor analysis for ${ticker}...`);

  try {
    const resp = await fetch(`${API_BASE}/api/analysis/advisor/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: ticker,
        fund_name: null,
        investor_age: null,
        risk_tolerance: null,
      }),
    });

    if (!resp.ok) {
      const error = await resp.json();
      showToast(`Error: ${error.detail}`, 'error');
      return;
    }

    const result = await resp.json();
    displayAdvisorAnalysis(result);
    showToast('Advisor analysis complete', 'success');
  } catch (error) {
    console.error('Advisor analysis error:', error);
    showToast('Failed to get advisor analysis', 'error');
  } finally {
    hideLoading();
  }
}

function displayAdvisorAnalysis(result) {
  // Hide quick analysis, show advisor analysis
  document.getElementById('fund-analysis-result').style.display = 'none';
  document.getElementById('advisor-analysis-result').style.display = 'block';

  // Populate advisor analysis fields
  document.getElementById('advisor-summary').textContent = result.summary || 'No summary available.';
  document.getElementById('advisor-commentary').innerHTML = formatAdvisorText(result.advisor_commentary);
  document.getElementById('advisor-portfolio-fit').textContent =
    result.portfolio_fit || 'No portfolio fit analysis available.';
  document.getElementById('advisor-tax').textContent = result.tax_considerations || 'No tax considerations available.';
  document.getElementById('advisor-risk').textContent = result.risk_notes || 'No risk notes available.';

  // Show overlaps if present
  const overlapsSection = document.getElementById('advisor-overlaps-section');
  const overlapsContainer = document.getElementById('advisor-overlaps');
  if (result.overlaps && result.overlaps.length > 0) {
    overlapsSection.style.display = 'block';
    overlapsContainer.innerHTML = result.overlaps
      .map(
        (o) => `
            <div class="overlap-item">
                <span class="overlap-ticker">${o.ticker || 'Unknown'}</span>
                ${o.overlap_pct ? `<span class="overlap-pct">${o.overlap_pct}% overlap</span>` : ''}
                <span class="overlap-desc">${o.description || ''}</span>
            </div>
        `
      )
      .join('');
  } else {
    overlapsSection.style.display = 'none';
  }

  // Show recommendations if present
  const recsSection = document.getElementById('advisor-recommendations-section');
  const recsList = document.getElementById('advisor-recommendations');
  if (result.recommendations && result.recommendations.length > 0) {
    recsSection.style.display = 'block';
    recsList.innerHTML = result.recommendations.map((r) => `<li>${r}</li>`).join('');
  } else {
    recsSection.style.display = 'none';
  }
}

function formatAdvisorText(text) {
  if (!text) return 'No commentary available.';
  // Convert line breaks to <br> and paragraphs
  return text
    .split('\n\n')
    .map((p) => `<p>${p}</p>`)
    .join('');
}

// Advisor Chat
let currentAnalysisTicker = null;

// Configure marked.js for safe rendering
if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });
}

// Render markdown content safely
function renderMarkdown(content) {
  if (typeof marked !== 'undefined') {
    return marked.parse(content);
  }
  // Fallback: basic text with line breaks
  return content.replace(/\n/g, '<br>');
}

// Build page context for context-aware chat
function buildPageContext() {
  // Get active tab
  const activeTabBtn = document.querySelector('.tab-btn.active');
  const activeTab = activeTabBtn?.dataset?.tab || 'dashboard';

  const context = {
    active_tab: activeTab,
    visible_data: {},
    selected_ticker: currentAnalysisTicker || null,
  };

  // Try to get portfolio summary from the DOM
  try {
    const totalValueEl = document.getElementById('total-value');
    const retirementValueEl = document.getElementById('retirement-value');
    const taxableValueEl = document.getElementById('taxable-value');

    if (totalValueEl) {
      context.visible_data.portfolio_summary = {
        total_value: parseFloat(totalValueEl.textContent.replace(/[$,]/g, '')) || 0,
        retirement_value: retirementValueEl ? parseFloat(retirementValueEl.textContent.replace(/[$,]/g, '')) || 0 : 0,
        taxable_value: taxableValueEl ? parseFloat(taxableValueEl.textContent.replace(/[$,]/g, '')) || 0 : 0,
      };
    }
  } catch (e) {
    console.log('Could not get portfolio summary for context');
  }

  // Tab-specific data
  if (activeTab === 'holdings' && currentPositions && currentPositions.length > 0) {
    context.visible_data.positions = currentPositions.slice(0, 20).map((p) => ({
      ticker: p.ticker,
      name: p.name,
      value: p.value || p.shares * p.current_price || 0,
      shares: p.shares,
      account_name: p.account_name,
      account_type: p.account_type,
    }));
  }

  if (activeTab === 'analysis' && window.detailedAllocation) {
    const alloc = window.detailedAllocation;
    context.visible_data.allocation = {
      cash_allocation: alloc.cash_allocation || 0,
      invested_allocation: alloc.invested_allocation || 0,
      by_sector: {},
      concentration_top5: 0,
    };

    // Convert sector array to object
    if (alloc.by_sector && Array.isArray(alloc.by_sector)) {
      for (const item of alloc.by_sector) {
        if (item.name && item.current_pct !== undefined) {
          context.visible_data.allocation.by_sector[item.name] = item.current_pct;
        }
      }
    }

    // Try to get concentration from DOM
    const concEl = document.getElementById('concentration-top5');
    if (concEl) {
      context.visible_data.allocation.concentration_top5 = parseFloat(concEl.textContent) || 0;
    }

    // Get performance data from DOM
    const ytdEl = document.getElementById('ytd-return');
    const alphaEl = document.getElementById('alpha-ytd');
    if (ytdEl) {
      context.visible_data.performance = {
        ytd_return: parseFloat(ytdEl.textContent) || 0,
        alpha_ytd: alphaEl ? parseFloat(alphaEl.textContent) || 0 : 0,
      };
    }

    // Get risk data from DOM
    const volEl = document.getElementById('volatility');
    const sharpeEl = document.getElementById('sharpe-ratio');
    const betaEl = document.getElementById('beta');
    if (volEl || sharpeEl || betaEl) {
      context.visible_data.risk = {
        volatility: volEl ? parseFloat(volEl.textContent) || 0 : null,
        sharpe_ratio: sharpeEl ? parseFloat(sharpeEl.textContent) || 0 : null,
        beta: betaEl ? parseFloat(betaEl.textContent) || 1.0 : null,
      };
    }
  }

  // Add projection context if available
  if (activeTab === 'projections' && window.lastMonteCarloResult) {
    context.visible_data.monte_carlo_results = {
      success_rate: window.lastMonteCarloResult.success_rate,
      median_final_value: window.lastMonteCarloResult.median_final_value,
    };
  }

  // Store last Monte Carlo params if available
  if (activeTab === 'projections') {
    const currentAge = document.getElementById('projection-current-age')?.value;
    const retirementAge = document.getElementById('projection-retirement-age')?.value;
    const monthlyWithdrawal = document.getElementById('projection-withdrawal')?.value;
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

// Format tool names for display
function formatToolName(name) {
  const names = {
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
  return names[name] || name.replace(/_/g, ' ');
}

// Enhanced streaming chat function with tool support and page context
async function sendStreamingChatMessageV2(containerId, inputId, ticker = null) {
  const input = document.getElementById(inputId);
  const container = document.getElementById(containerId);
  const message = input.value.trim();

  if (!message) return;

  // Clear input and disable while streaming
  input.value = '';
  input.disabled = true;

  // Add user message to chat
  addChatMessageToContainer(container, 'user', message);

  // Create assistant message div for streaming
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
    const response = await fetch(`${API_BASE}/api/analysis/advisor/chat/stream/v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        ticker: ticker,
        include_portfolio: true,
        page_context: pageContext,
      }),
    });

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
            const event = JSON.parse(line.substring(6));

            if (event.type === 'text') {
              fullContent += event.content;
              contentDiv.textContent = fullContent;
              container.scrollTop = container.scrollHeight;
            } else if (event.type === 'tool_start') {
              // Show tool indicator
              const toolIndicator = document.createElement('div');
              toolIndicator.className = 'tool-indicator';
              toolIndicator.id = `tool-${event.id}`;
              toolIndicator.textContent = `Looking up ${formatToolName(event.name)}...`;
              contentDiv.appendChild(toolIndicator);
              container.scrollTop = container.scrollHeight;
            } else if (event.type === 'tool_result') {
              // Remove tool indicator
              const indicators = contentDiv.querySelectorAll('.tool-indicator');
              indicators.forEach((ind) => ind.remove());
            } else if (event.type === 'done') {
              contentDiv.classList.remove('streaming-cursor');
              // Remove any remaining tool indicators
              const indicators = contentDiv.querySelectorAll('.tool-indicator');
              indicators.forEach((ind) => ind.remove());
              // Use safe markdown rendering (marked.js with existing config)
              contentDiv.innerHTML = renderMarkdown(fullContent);
            } else if (event.type === 'error') {
              contentDiv.classList.remove('streaming-cursor');
              contentDiv.textContent = `Error: ${event.message}`;
            }
          } catch (e) {
            // JSON parse error - might be partial data, ignore
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

// Generic streaming chat function that works with any container (legacy v1)
async function sendStreamingChatMessage(containerId, inputId, ticker = null) {
  const input = document.getElementById(inputId);
  const container = document.getElementById(containerId);
  const message = input.value.trim();

  if (!message) return;

  // Clear input and disable while streaming
  input.value = '';
  input.disabled = true;

  // Add user message to chat
  addChatMessageToContainer(container, 'user', message);

  // Create assistant message div for streaming
  const messageDiv = document.createElement('div');
  messageDiv.className = 'chat-message assistant';
  const contentDiv = document.createElement('div');
  contentDiv.className = 'chat-message-content streaming-cursor';
  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  let fullContent = '';

  try {
    const response = await fetch(`${API_BASE}/api/analysis/advisor/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        ticker: ticker,
        include_portfolio: true,
      }),
    });

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
            // Streaming complete - render final markdown
            contentDiv.classList.remove('streaming-cursor');
            contentDiv.innerHTML = renderMarkdown(fullContent);
          } else {
            // Unescape newlines and append
            const text = data.replace(/\\n/g, '\n');
            fullContent += text;
            // Update with plain text while streaming (faster)
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

// Add a message to a specific chat container
function addChatMessageToContainer(container, role, content, useMarkdown = false) {
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
    contentDiv.innerHTML = renderMarkdown(content);
  } else {
    contentDiv.textContent = content;
  }

  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  return messageDiv;
}

// Analysis page chat (embedded in Analysis tab)
async function sendChatMessage() {
  await sendStreamingChatMessageV2('chat-messages', 'chat-input', currentAnalysisTicker);
}

function addChatMessage(role, content, isHtml = false) {
  const container = document.getElementById('chat-messages');

  if (isHtml) {
    // Remove placeholder if present
    const placeholder = container.querySelector('.chat-placeholder');
    if (placeholder) placeholder.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    contentDiv.innerHTML = content;
    messageDiv.appendChild(contentDiv);
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
    return messageDiv;
  }

  return addChatMessageToContainer(container, role, content, role === 'assistant');
}

function handleChatKeypress(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
}

async function clearAdvisorChat() {
  try {
    await fetch(`${API_BASE}/api/analysis/advisor/chat/clear`, { method: 'POST' });

    const container = document.getElementById('chat-messages');
    container.innerHTML = `
            <div class="chat-placeholder">
                <p>Ask a question to start the conversation...</p>
                <p class="text-muted">Examples:</p>
                <ul class="text-muted">
                    <li>"Should I be concerned about my technology exposure?"</li>
                    <li>"What's the difference between VTI and VOO?"</li>
                    <li>"Is my portfolio too aggressive for someone my age?"</li>
                </ul>
            </div>
        `;

    showToast('Chat history cleared', 'success');
  } catch (error) {
    showToast('Failed to clear chat', 'error');
  }
}

// ==========================================
// Global Chat Modal Functions
// ==========================================

function showGlobalChat() {
  document.getElementById('global-chat-modal').style.display = 'flex';
  document.getElementById('global-chat-input').focus();
}

function hideGlobalChat() {
  document.getElementById('global-chat-modal').style.display = 'none';
}

async function sendGlobalChatMessage() {
  await sendStreamingChatMessageV2('global-chat-messages', 'global-chat-input', null);
}

function handleGlobalChatKeypress(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendGlobalChatMessage();
  }
}

async function clearGlobalChat() {
  try {
    await fetch(`${API_BASE}/api/analysis/advisor/chat/clear`, { method: 'POST' });

    const container = document.getElementById('global-chat-messages');
    container.innerHTML = `
            <div class="chat-placeholder">
                <p>Ask a question about your portfolio...</p>
                <p class="text-muted">Examples:</p>
                <ul class="text-muted">
                    <li>"Should I be concerned about my technology exposure?"</li>
                    <li>"What's the difference between VTI and VOO?"</li>
                    <li>"Is my portfolio too aggressive for someone my age?"</li>
                    <li>"How can I improve my diversification?"</li>
                </ul>
            </div>
        `;

    showToast('Chat history cleared', 'success');
  } catch (error) {
    showToast('Failed to clear chat', 'error');
  }
}

// Keyboard shortcut to open chat (Ctrl+K or Cmd+K)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const modal = document.getElementById('global-chat-modal');
    if (modal.style.display === 'none' || !modal.style.display) {
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

// Settings Management
async function loadSettings() {
  try {
    // Load config
    const configResp = await fetch(`${API_BASE}/api/settings/config`);
    const config = await configResp.json();

    // Personal settings
    if (config.personal) {
      document.getElementById('settings-dob').value = config.personal.dob || '';
      document.getElementById('settings-retirement-age').value = config.personal.retirement_age || 65;
      document.getElementById('settings-withdrawal-rate').value = config.personal.withdrawal_rate || 4;
      document.getElementById('settings-target-income').value = config.personal.target_monthly_income || 0;
    }

    // Asset class targets
    if (config.targets?.asset_class) {
      document.getElementById('target-equities').value = (config.targets.asset_class.equities || 0) * 100;
      document.getElementById('target-bonds').value = (config.targets.asset_class.bonds || 0) * 100;
      document.getElementById('target-alternatives').value = (config.targets.asset_class.alternatives || 0) * 100;
      document.getElementById('target-cash').value = (config.targets.asset_class.cash || 0) * 100;
    }

    // Market assumptions
    if (config.market) {
      document.getElementById('market-stock-return').value = (config.market.stock_mean_return || 0) * 100;
      document.getElementById('market-stock-std').value = (config.market.stock_std_dev || 0) * 100;
      document.getElementById('market-bond-return').value = (config.market.bond_mean_return || 0) * 100;
      document.getElementById('market-bond-std').value = (config.market.bond_std_dev || 0) * 100;
      document.getElementById('market-inflation').value = (config.market.inflation_rate || 0) * 100;
      document.getElementById('market-risk-free').value = (config.market.risk_free_rate || 0) * 100;
    }

    // Monte Carlo settings
    if (config.monte_carlo) {
      document.getElementById('mc-simulations').value = config.monte_carlo.num_simulations || 10000;
      document.getElementById('mc-black-swan-prob').value = (config.monte_carlo.black_swan_probability || 0) * 100;
      document.getElementById('mc-black-swan-impact').value = (config.monte_carlo.black_swan_impact || 0) * 100;
      document.getElementById('mc-golden-swan-prob').value = (config.monte_carlo.golden_swan_probability || 0) * 100;
      document.getElementById('mc-golden-swan-impact').value = (config.monte_carlo.golden_swan_impact || 0) * 100;
    }

    // Load API keys status, views, accounts management, and AI providers
    await Promise.all([loadApiKeysStatus(), loadViewsList(), loadAccountsManagement(), loadAIProviders()]);
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// AI Provider Management
let aiProvidersData = [];

async function loadAIProviders() {
  try {
    const response = await fetch(`${API_BASE}/api/inference/providers`);
    if (!response.ok) {
      console.warn('Could not load AI providers:', response.status);
      return;
    }

    const data = await response.json();
    aiProvidersData = data.providers || [];

    const providerSelect = document.getElementById('ai-provider-select');
    const modelSelect = document.getElementById('ai-model-select');
    const statusEl = document.getElementById('ai-provider-status');

    if (!providerSelect || !modelSelect) return;

    // Get saved preferences from localStorage
    const savedProvider = localStorage.getItem('preferredAIProvider') || 'claude';
    const savedModel = localStorage.getItem('preferredAIModel') || '';

    // Populate provider dropdown
    providerSelect.innerHTML = aiProvidersData.map(p => {
      const availability = p.is_available ? '' : ' (not configured)';
      return `<option value="${p.id}" ${p.id === savedProvider ? 'selected' : ''}>${p.display_name}${availability}</option>`;
    }).join('');

    // Update model dropdown based on selected provider
    updateAIModelSelect(savedProvider, savedModel);

    // Update status message
    const currentProvider = aiProvidersData.find(p => p.id === savedProvider);
    if (currentProvider && currentProvider.is_available) {
      statusEl.textContent = `Connected to ${currentProvider.display_name}`;
      statusEl.className = 'form-help text-success';
    } else if (currentProvider) {
      statusEl.textContent = `${currentProvider.display_name} requires an API key. Add it in Data Sources above.`;
      statusEl.className = 'form-help text-warning';
    }
  } catch (error) {
    console.error('Error loading AI providers:', error);
    const statusEl = document.getElementById('ai-provider-status');
    if (statusEl) {
      statusEl.textContent = 'Could not load AI providers';
      statusEl.className = 'form-help text-muted';
    }
  }
}

function updateAIModelSelect(providerId, selectedModelId) {
  const modelSelect = document.getElementById('ai-model-select');
  const modelInfo = document.getElementById('ai-model-info');
  if (!modelSelect) return;

  const provider = aiProvidersData.find(p => p.id === providerId);
  if (!provider || !provider.models || provider.models.length === 0) {
    modelSelect.innerHTML = '<option value="">No models available</option>';
    if (modelInfo) modelInfo.textContent = '';
    return;
  }

  // Populate models
  modelSelect.innerHTML = provider.models.map(m => {
    const isDefault = m.is_default ? ' (default)' : '';
    const selected = (selectedModelId && m.id === selectedModelId) || (!selectedModelId && m.is_default);
    return `<option value="${m.id}" ${selected ? 'selected' : ''}>${m.display_name}${isDefault}</option>`;
  }).join('');

  // Update model info
  const currentModel = provider.models.find(m =>
    (selectedModelId && m.id === selectedModelId) || (!selectedModelId && m.is_default)
  );
  if (currentModel && modelInfo) {
    const capabilities = currentModel.capabilities.join(', ');
    modelInfo.textContent = `Context: ${(currentModel.context_length / 1000).toFixed(0)}K tokens | Supports: ${capabilities}`;
  }
}

function onAIProviderChange(providerId) {
  localStorage.setItem('preferredAIProvider', providerId);
  localStorage.removeItem('preferredAIModel'); // Reset model when provider changes

  updateAIModelSelect(providerId, null);

  const statusEl = document.getElementById('ai-provider-status');
  const provider = aiProvidersData.find(p => p.id === providerId);
  if (provider && provider.is_available) {
    statusEl.textContent = `Connected to ${provider.display_name}`;
    statusEl.className = 'form-help text-success';
  } else if (provider) {
    statusEl.textContent = `${provider.display_name} requires an API key. Add it in Data Sources above.`;
    statusEl.className = 'form-help text-warning';
  }
}

function onAIModelChange(modelId) {
  localStorage.setItem('preferredAIModel', modelId);

  const modelInfo = document.getElementById('ai-model-info');
  const providerId = localStorage.getItem('preferredAIProvider') || 'claude';
  const provider = aiProvidersData.find(p => p.id === providerId);

  if (provider && modelInfo) {
    const model = provider.models.find(m => m.id === modelId);
    if (model) {
      const capabilities = model.capabilities.join(', ');
      modelInfo.textContent = `Context: ${(model.context_length / 1000).toFixed(0)}K tokens | Supports: ${capabilities}`;
    }
  }
}

// Helper to get current AI provider preferences for API calls
function getAIPreferences() {
  return {
    provider_id: localStorage.getItem('preferredAIProvider') || null,
    model_id: localStorage.getItem('preferredAIModel') || null,
  };
}

// Account Management
async function loadAccountsManagement() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/accounts`);
    const accounts = await response.json();

    const tbody = document.getElementById('accounts-management-body');
    if (!tbody) return;

    if (accounts.length === 0) {
      tbody.innerHTML = `
                <tr>
                    <td colspan="3" class="no-data">No accounts found. Add your first account above.</td>
                </tr>
            `;
      return;
    }

    tbody.innerHTML = accounts
      .map(
        (account) => `
            <tr>
                <td>
                    <div class="account-info">
                        <span class="account-name">${account.name}</span>
                        <span class="account-meta">${account.display_type} · ${account.brokerage || 'N/A'} · ${
          account.position_count || 0
        } positions</span>
                    </div>
                </td>
                <td class="text-right">${formatCurrency(account.value || 0)}</td>
                <td class="text-right">
                    <button class="btn btn-sm btn-danger" onclick="deleteAccount('${
                      account.id
                    }', '${account.name.replace(/'/g, "\\'")}')">
                        Delete
                    </button>
                </td>
            </tr>
        `
      )
      .join('');
  } catch (error) {
    console.error('Error loading accounts for management:', error);
  }
}

async function deleteAccount(accountId, accountName) {
  // Show confirmation dialog
  const confirmed = confirm(
    `Are you sure you want to delete "${accountName}"?\n\n` +
      `This will permanently delete:\n` +
      `• The account\n` +
      `• All positions in this account\n\n` +
      `This action cannot be undone.`
  );

  if (!confirmed) return;

  // Double-check for extra safety
  const doubleConfirm = confirm(
    `FINAL CONFIRMATION\n\n` +
      `You are about to permanently delete "${accountName}" and all its data.\n\n` +
      `Click OK to proceed with deletion.`
  );

  if (!doubleConfirm) return;

  try {
    showLoading('Deleting account...');
    const response = await fetch(`${API_BASE}/api/portfolio/accounts/${accountId}`, {
      method: 'DELETE',
    });

    if (response.ok) {
      showToast(`Account "${accountName}" deleted successfully`, 'success');
      // Reload everything
      await Promise.all([loadAccountsManagement(), refreshData(), loadViews()]);
    } else {
      const error = await response.json();
      showToast(`Error: ${error.detail || 'Failed to delete account'}`, 'error');
    }
  } catch (error) {
    console.error('Error deleting account:', error);
    showToast('Failed to delete account', 'error');
  } finally {
    hideLoading();
  }
}

// CSV Export Functions
async function exportToCSV(dataType) {
  try {
    showLoading(`Exporting ${dataType}...`);

    const response = await fetch(`${API_BASE}/api/portfolio/export/${dataType}`);
    if (!response.ok) {
      throw new Error(`Failed to export ${dataType}`);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 10);
    a.download = `portfolio_${dataType}_${timestamp}.csv`;

    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();

    showToast(`${dataType.charAt(0).toUpperCase() + dataType.slice(1)} exported successfully`, 'success');
  } catch (error) {
    console.error(`Error exporting ${dataType}:`, error);
    showToast(`Failed to export ${dataType}`, 'error');
  } finally {
    hideLoading();
  }
}

async function exportAllToCSV() {
  try {
    showLoading('Exporting all data...');

    // Export each type sequentially
    const types = ['accounts', 'positions', 'snapshots'];
    const timestamp = new Date().toISOString().slice(0, 10);

    for (const dataType of types) {
      const response = await fetch(`${API_BASE}/api/portfolio/export/${dataType}`);
      if (!response.ok) {
        console.error(`Failed to export ${dataType}`);
        continue;
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `portfolio_${dataType}_${timestamp}.csv`;

      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();

      // Small delay between downloads
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    showToast('All data exported successfully', 'success');
  } catch (error) {
    console.error('Error exporting all data:', error);
    showToast('Failed to export data', 'error');
  } finally {
    hideLoading();
  }
}

async function loadApiKeysStatus() {
  try {
    const resp = await fetch(`${API_BASE}/api/settings/api-keys/status`);
    const data = await resp.json();

    const container = document.getElementById('api-keys-status');
    if (!container) return;

    const keyNames = {
      alpha_vantage: 'Alpha Vantage',
      massive: 'Massive',
      finnhub: 'Finnhub',
      anthropic_api_key: 'Anthropic (Claude)',
      gemini_api_key: 'Google Gemini',
      openai_api_key: 'OpenAI',
      cerebras_api_key: 'Cerebras',
      fmp_api_key: 'Financial Modeling Prep',
    };

    const keyDescriptions = {
      alpha_vantage: 'Stock prices & fundamentals',
      massive: 'Price data backup',
      finnhub: 'Real-time stock prices',
      anthropic_api_key: 'AI fund analysis & insights',
      gemini_api_key: 'AI fund analysis & insights',
      openai_api_key: 'AI fund analysis & insights',
      cerebras_api_key: 'AI fund analysis & insights',
      fmp_api_key: 'ETF sector weightings & fund data',
    };

    container.innerHTML = Object.entries(data.api_keys)
      .map(
        ([key, status]) => `
            <div class="api-key-item" id="api-key-${key}">
                <div class="api-key-icon ${status.configured ? 'configured' : 'not-configured'}">
                    ${status.configured ? '✓' : '○'}
                </div>
                <div class="api-key-info">
                    <div class="api-key-name">${keyNames[key] || key}</div>
                    <div class="api-key-source">${keyDescriptions[key] || ''}</div>
                </div>
                <div class="api-key-actions">
                    <span class="api-key-status ${status.configured ? 'configured' : 'not-configured'}">
                        ${status.configured ? status.source : 'Not set'}
                    </span>
                    <button class="btn btn-sm btn-default" onclick="showApiKeyEditor('${key}', '${
          keyNames[key] || key
        }')">
                        ${status.configured ? 'Edit' : 'Add'}
                    </button>
                </div>
            </div>
        `
      )
      .join('');
  } catch (error) {
    console.error('Error loading API keys status:', error);
  }
}

function showApiKeyEditor(keyId, keyName) {
  const content = `
        <div class="api-key-editor">
            <p>Enter your ${keyName} API key. It will be securely stored in the database.</p>
            <div class="form-group">
                <label for="api-key-input">API Key</label>
                <input type="password" id="api-key-input" class="form-control" placeholder="Paste your API key here">
            </div>
            <div class="form-group" style="margin-top: 16px;">
                <label class="checkbox-label">
                    <input type="checkbox" id="api-key-show" onchange="toggleApiKeyVisibility()">
                    <span>Show key</span>
                </label>
            </div>
            <div class="modal-actions" style="margin-top: 20px; display: flex; gap: 12px; justify-content: flex-end;">
                <button class="btn btn-default" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="deleteApiKey('${keyId}')" style="margin-right: auto;">Delete</button>
                <button class="btn btn-primary" onclick="saveApiKey('${keyId}')">Save Key</button>
            </div>
        </div>
    `;
  showModal(`Configure ${keyName}`, content);
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('api-key-input');
  const show = document.getElementById('api-key-show').checked;
  input.type = show ? 'text' : 'password';
}

async function saveApiKey(keyId) {
  const input = document.getElementById('api-key-input');
  const value = input.value.trim();

  if (!value) {
    showToast('Please enter an API key', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/settings/api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: keyId, value: value }),
    });

    if (response.ok) {
      showToast('API key saved successfully', 'success');
      closeModal();
      await loadApiKeysStatus();
    } else {
      const error = await response.json();
      showToast(`Error: ${error.detail || 'Failed to save key'}`, 'error');
    }
  } catch (error) {
    console.error('Error saving API key:', error);
    showToast('Failed to save API key', 'error');
  }
}

async function deleteApiKey(keyId) {
  if (!confirm('Are you sure you want to delete this API key?')) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/settings/api-key/${keyId}`, {
      method: 'DELETE',
    });

    if (response.ok) {
      showToast('API key deleted', 'success');
      closeModal();
      await loadApiKeysStatus();
    } else {
      showToast('Failed to delete API key', 'error');
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    showToast('Failed to delete API key', 'error');
  }
}

let allAccountsCache = [];

async function loadViewsList() {
  try {
    // Fetch views and accounts in parallel
    const [viewsResp, accountsResp] = await Promise.all([
      fetch(`${API_BASE}/api/settings/views`),
      fetch(`${API_BASE}/api/portfolio/accounts`),
    ]);

    const views = await viewsResp.json();
    const accounts = await accountsResp.json();
    allAccountsCache = accounts;

    const container = document.getElementById('views-list');
    if (!container) return;

    if (views.length === 0) {
      container.innerHTML = '<p class="empty-message">No views created yet.</p>';
      return;
    }

    container.innerHTML = views
      .map((view) => {
        const accountNames = view.account_ids
          .map((id) => accounts.find((a) => a.id === id))
          .filter((a) => a)
          .map((a) => a.name)
          .slice(0, 3);
        const moreCount = view.account_ids.length - accountNames.length;

        return `
                <div class="view-item ${view.is_default ? 'is-default' : ''}">
                    <div class="view-info">
                        <div class="view-name">
                            ${view.name}
                            ${view.is_default ? '<span class="default-badge">Default</span>' : ''}
                        </div>
                        <div class="view-accounts">
                            ${accountNames.join(', ')}${moreCount > 0 ? ` +${moreCount} more` : ''}
                        </div>
                    </div>
                    <div class="view-actions">
                        ${
                          view.name !== 'All Accounts'
                            ? `
                            <button onclick="editView('${view.id}')">Edit</button>
                            ${
                              !view.is_default
                                ? `<button onclick="setDefaultView('${view.id}')">Set Default</button>`
                                : ''
                            }
                            <button class="danger" onclick="deleteView('${view.id}')">Delete</button>
                        `
                            : ''
                        }
                    </div>
                </div>
            `;
      })
      .join('');
  } catch (error) {
    console.error('Error loading views:', error);
  }
}

// View Modal Functions
function showCreateViewModal() {
  document.getElementById('view-modal-title').textContent = 'Create Portfolio View';
  document.getElementById('view-edit-id').value = '';
  document.getElementById('view-name').value = '';
  document.getElementById('view-is-default').checked = false;

  // Populate accounts checkboxes
  const listContainer = document.getElementById('view-accounts-list');
  listContainer.innerHTML = allAccountsCache
    .map(
      (acc) => `
        <label class="checkbox-label">
            <input type="checkbox" name="view-account" value="${acc.id}">
            <span>${acc.name}</span>
            <span class="account-type">${acc.display_type}</span>
        </label>
    `
    )
    .join('');

  document.getElementById('view-modal').style.display = 'flex';
}

function editView(viewId) {
  const view = availableViews.find((v) => v.id === viewId);
  if (!view) return;

  document.getElementById('view-modal-title').textContent = 'Edit Portfolio View';
  document.getElementById('view-edit-id').value = viewId;
  document.getElementById('view-name').value = view.name;
  document.getElementById('view-is-default').checked = view.is_default;

  // Populate accounts checkboxes with current selections
  const listContainer = document.getElementById('view-accounts-list');
  listContainer.innerHTML = allAccountsCache
    .map(
      (acc) => `
        <label class="checkbox-label">
            <input type="checkbox" name="view-account" value="${acc.id}" ${
        view.account_ids.includes(acc.id) ? 'checked' : ''
      }>
            <span>${acc.name}</span>
            <span class="account-type">${acc.display_type}</span>
        </label>
    `
    )
    .join('');

  document.getElementById('view-modal').style.display = 'flex';
}

function hideViewModal() {
  document.getElementById('view-modal').style.display = 'none';
}

async function saveView(event) {
  event.preventDefault();

  const editId = document.getElementById('view-edit-id').value;
  const name = document.getElementById('view-name').value;
  const isDefault = document.getElementById('view-is-default').checked;

  // Get selected account IDs
  const checkboxes = document.querySelectorAll('input[name="view-account"]:checked');
  const accountIds = Array.from(checkboxes).map((cb) => cb.value);

  if (accountIds.length === 0) {
    showToast('Please select at least one account', 'error');
    return;
  }

  try {
    const url = editId ? `${API_BASE}/api/settings/views/${editId}` : `${API_BASE}/api/settings/views`;
    const method = editId ? 'PUT' : 'POST';

    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, account_ids: accountIds, is_default: isDefault }),
    });

    if (resp.ok) {
      showToast(editId ? 'View updated' : 'View created', 'success');
      hideViewModal();
      await loadViews();
      loadViewsList();
    } else {
      const error = await resp.json();
      showToast(`Error: ${error.detail}`, 'error');
    }
  } catch (error) {
    showToast('Failed to save view', 'error');
  }
}

async function setDefaultView(viewId) {
  try {
    const resp = await fetch(`${API_BASE}/api/settings/views/${viewId}/set-default`, {
      method: 'PUT',
    });

    if (resp.ok) {
      showToast('Default view updated', 'success');
      await loadViews();
      loadViewsList();
    }
  } catch (error) {
    showToast('Failed to set default view', 'error');
  }
}

async function deleteView(viewId) {
  if (!confirm('Delete this view?')) return;

  try {
    const resp = await fetch(`${API_BASE}/api/settings/views/${viewId}`, {
      method: 'DELETE',
    });

    if (resp.ok) {
      showToast('View deleted', 'success');
      await loadViews();
      loadViewsList();

      // If we deleted the current view, reset to default
      if (currentViewId === viewId) {
        currentViewId = null;
        localStorage.removeItem('portfolioViewId');
        refreshData();
      }
    }
  } catch (error) {
    showToast('Failed to delete view', 'error');
  }
}

// Keep for backward compatibility
async function checkApiKeyStatus() {
  try {
    const resp = await fetch(`${API_BASE}/api/settings/api-key/anthropic_api_key`);
    const status = await resp.json();

    const statusEl = document.getElementById('anthropic-key-status');
    if (!statusEl) return;

    if (status.configured) {
      statusEl.textContent = `Configured (${status.source})`;
      statusEl.className = 'key-status configured';
    } else {
      statusEl.textContent = 'Not configured';
      statusEl.className = 'key-status not-configured';
    }
  } catch (error) {
    console.error('Error checking API key status:', error);
  }
}

async function savePersonalSettings(event) {
  event.preventDefault();

  // Validate withdrawal rate (1-100)
  const withdrawalRate = parseInt(document.getElementById('settings-withdrawal-rate').value);
  if (isNaN(withdrawalRate) || withdrawalRate < 1 || withdrawalRate > 100) {
    showToast('Withdrawal rate must be between 1 and 100', 'error');
    return;
  }

  const data = {
    dob: document.getElementById('settings-dob').value,
    retirement_age: parseInt(document.getElementById('settings-retirement-age').value),
    withdrawal_rate: withdrawalRate,
    target_monthly_income: parseFloat(document.getElementById('settings-target-income').value) || 0,
  };

  try {
    await fetch(`${API_BASE}/api/settings/config/personal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    showToast('Personal settings saved', 'success');
    // Refresh dashboard metrics to reflect new withdrawal rate
    await loadRetirementMetrics();
  } catch (error) {
    showToast('Failed to save settings', 'error');
  }
}

async function saveAssetClassTargets(event) {
  event.preventDefault();

  const data = {
    equities: parseFloat(document.getElementById('target-equities').value) / 100,
    bonds: parseFloat(document.getElementById('target-bonds').value) / 100,
    alternatives: parseFloat(document.getElementById('target-alternatives').value) / 100,
    cash: parseFloat(document.getElementById('target-cash').value) / 100,
  };

  try {
    await fetch(`${API_BASE}/api/settings/config/targets/asset_class`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    showToast('Asset targets saved', 'success');
  } catch (error) {
    showToast('Failed to save targets', 'error');
  }
}

async function saveMarketAssumptions(event) {
  event.preventDefault();

  const data = {
    stock_mean_return: parseFloat(document.getElementById('market-stock-return').value) / 100,
    stock_std_dev: parseFloat(document.getElementById('market-stock-std').value) / 100,
    bond_mean_return: parseFloat(document.getElementById('market-bond-return').value) / 100,
    bond_std_dev: parseFloat(document.getElementById('market-bond-std').value) / 100,
    stock_bond_correlation: -0.2, // Keep default
    inflation_rate: parseFloat(document.getElementById('market-inflation').value) / 100,
    risk_free_rate: parseFloat(document.getElementById('market-risk-free').value) / 100,
  };

  try {
    await fetch(`${API_BASE}/api/settings/config/market`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    showToast('Market assumptions saved', 'success');
  } catch (error) {
    showToast('Failed to save assumptions', 'error');
  }
}

async function saveMonteCarloSettings(event) {
  event.preventDefault();

  const data = {
    num_simulations: parseInt(document.getElementById('mc-simulations').value),
    black_swan_probability: parseFloat(document.getElementById('mc-black-swan-prob').value) / 100,
    black_swan_impact: parseFloat(document.getElementById('mc-black-swan-impact').value) / 100,
    golden_swan_probability: parseFloat(document.getElementById('mc-golden-swan-prob').value) / 100,
    golden_swan_impact: parseFloat(document.getElementById('mc-golden-swan-impact').value) / 100,
    t_distribution_df: 5, // Keep default
  };

  try {
    await fetch(`${API_BASE}/api/settings/config/monte_carlo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    showToast('Monte Carlo settings saved', 'success');
  } catch (error) {
    showToast('Failed to save settings', 'error');
  }
}

async function saveApiKey(event) {
  event.preventDefault();

  const key = document.getElementById('anthropic-api-key').value;
  if (!key) {
    showToast('Please enter an API key', 'error');
    return;
  }

  try {
    await fetch(`${API_BASE}/api/settings/api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'anthropic_api_key',
        value: key,
      }),
    });
    document.getElementById('anthropic-api-key').value = '';
    showToast('API key saved', 'success');
    checkApiKeyStatus();
  } catch (error) {
    showToast('Failed to save API key', 'error');
  }
}

// Monte Carlo projections
async function runProjection(event) {
  event.preventDefault();

  showLoading('Running Monte Carlo simulation...', true); // Enable rotating messages
  const form = event.target;
  form.classList.add('loading');

  const params = {
    current_age: parseInt(document.getElementById('current-age').value),
    retirement_age: parseInt(document.getElementById('retirement-age').value),
    monthly_contribution: parseFloat(document.getElementById('monthly-contribution').value),
    monthly_withdrawal: parseFloat(document.getElementById('monthly-withdrawal').value),
    stock_allocation: parseFloat(document.getElementById('stock-allocation').value) / 100,
    bond_allocation: parseFloat(document.getElementById('bond-allocation').value) / 100,
  };

  // Check if tax-aware mode is enabled
  const useTaxAware = document.getElementById('use-tax-aware')?.checked || false;

  if (useTaxAware) {
    params.use_tax_aware_withdrawals = true;
    params.account_balances = {
      taxable: parseFloat(document.getElementById('balance-taxable').value) || 0,
      traditional: parseFloat(document.getElementById('balance-traditional').value) || 0,
      roth: parseFloat(document.getElementById('balance-roth').value) || 0,
    };
    params.tax_rate_ordinary = (parseFloat(document.getElementById('tax-rate-ordinary').value) || 22) / 100;
    params.tax_rate_capital_gains = (parseFloat(document.getElementById('tax-rate-cap-gains').value) || 15) / 100;
    params.tax_rate_state = (parseFloat(document.getElementById('tax-rate-state').value) || 5) / 100;
    params.cost_basis_ratio = (parseFloat(document.getElementById('cost-basis-ratio').value) || 60) / 100;
    params.contribution_traditional_pct =
      (parseFloat(document.getElementById('contrib-traditional').value) || 60) / 100;
    params.contribution_roth_pct = (parseFloat(document.getElementById('contrib-roth').value) || 25) / 100;
    params.contribution_taxable_pct = (parseFloat(document.getElementById('contrib-taxable').value) || 15) / 100;
  }

  try {
    // Use async API helper - handles both sync and async (background task) responses
    // Always use async_mode=true for consistent experience (works locally and on Heroku)
    const result = await runAsyncApiCall(
      '/api/projections/monte-carlo?async_mode=true',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      {
        // Task polling options
        maxWaitMs: 300000, // 5 minutes max
        pollIntervalMs: 2000,
        onProgress: (task) => {
          // Update loading message with progress
          const progress = task.progress ? Math.round(task.progress * 100) : 0;
          const message = task.progress_message || `Running simulation... ${progress}%`;
          updateLoadingMessage(message);
        },
      }
    );

    displayProjectionResults(result, params.retirement_age);
  } catch (error) {
    console.error('Error running projection:', error);
    showToast('Failed to run projection: ' + error.message, 'error');
  } finally {
    form.classList.remove('loading');
    hideLoading();
  }
}

// Toggle tax-aware settings visibility
function toggleTaxAwareSettings() {
  const checkbox = document.getElementById('use-tax-aware');
  const settings = document.getElementById('tax-aware-settings');

  if (checkbox && settings) {
    settings.style.display = checkbox.checked ? 'block' : 'none';

    // Auto-load balances when enabling tax-aware mode
    if (checkbox.checked) {
      loadAccountBalancesByType();
    }
  }
}

// Load account balances by tax type from the API
async function loadAccountBalancesByType() {
  try {
    const response = await fetch(`${API_BASE}/api/projections/account-balances-by-type`);
    const data = await response.json();

    document.getElementById('balance-taxable').value = Math.round(data.taxable);
    document.getElementById('balance-traditional').value = Math.round(data.traditional);
    document.getElementById('balance-roth').value = Math.round(data.roth);

    showToast(`Loaded balances: $${formatNumber(data.total)} total`, 'success');
  } catch (error) {
    console.error('Error loading account balances:', error);
    showToast('Failed to load account balances', 'error');
  }
}

function displayProjectionResults(result, retirementAge) {
  document.getElementById('projection-results').style.display = 'block';

  const successRate = result.success_rate * 100;
  const successEl = document.getElementById('success-rate');
  successEl.textContent = `${successRate.toFixed(1)}%`;
  successEl.className =
    'stat-value ' + (successRate >= 90 ? 'text-success' : successRate >= 70 ? 'text-warning' : 'text-error');

  document.getElementById('median-final').textContent = formatCurrency(result.median_final_value);
  document.getElementById('worst-case').textContent = formatCurrency(result.worst_case_final);
  document.getElementById('best-case').textContent = formatCurrency(result.best_case_final);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const retirementIdx = result.ages.indexOf(retirementAge);

  Plotly.newPlot(
    'chart-projection',
    [
      {
        x: result.ages,
        y: result.percentile_90,
        type: 'scatter',
        mode: 'lines',
        name: '90th %',
        line: { color: '#49aa19', width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(73, 170, 25, 0.1)',
      },
      {
        x: result.ages,
        y: result.percentile_75,
        type: 'scatter',
        mode: 'lines',
        name: '75th %',
        line: { color: '#49aa19', width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(73, 170, 25, 0.15)',
      },
      {
        x: result.ages,
        y: result.median_values,
        type: 'scatter',
        mode: 'lines',
        name: 'Median',
        line: { color: '#1668dc', width: 3 },
      },
      {
        x: result.ages,
        y: result.percentile_25,
        type: 'scatter',
        mode: 'lines',
        name: '25th %',
        line: { color: '#d89614', width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(216, 150, 20, 0.15)',
      },
      {
        x: result.ages,
        y: result.percentile_10,
        type: 'scatter',
        mode: 'lines',
        name: '10th %',
        line: { color: '#dc4446', width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(220, 68, 70, 0.1)',
      },
    ],
    {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
      margin: { t: 20, b: 40, l: 100, r: 20 },
      xaxis: {
        title: 'Age',
        gridcolor: isDark ? '#303030' : '#f0f0f0',
      },
      yaxis: {
        title: { text: 'Portfolio Value', standoff: 15 },
        tickformat: '$,.0f',
        gridcolor: isDark ? '#303030' : '#f0f0f0',
        automargin: true,
      },
      legend: { orientation: 'h', y: 1.15 },
      hoverlabel: {
        bgcolor: isDark ? '#1f1f1f' : 'white',
        bordercolor: isDark ? '#424242' : '#d9d9d9',
        font: { color: isDark ? 'white' : 'black' },
      },
      shapes:
        retirementIdx >= 0
          ? [
              {
                type: 'line',
                x0: retirementAge,
                x1: retirementAge,
                y0: 0,
                y1: 1,
                yref: 'paper',
                line: { color: isDark ? '#424242' : '#d9d9d9', width: 2, dash: 'dash' },
              },
            ]
          : [],
    },
    plotlyConfig
  );
}

// FIRE calculator
async function calculateFire(event) {
  event.preventDefault();

  const params = {
    annual_spending: parseFloat(document.getElementById('annual-spending').value),
    monthly_contribution: parseFloat(document.getElementById('fire-contribution').value),
  };

  try {
    const response = await fetch(`${API_BASE}/api/projections/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const result = await response.json();

    document.getElementById('fire-results').style.display = 'flex';
    document.getElementById('fire-calc-number').textContent = formatCurrency(result.fire_number);
    document.getElementById('fire-calc-years').textContent =
      result.years_to_fire === Infinity ? 'Never' : `${result.years_to_fire.toFixed(1)} years`;
    document.getElementById('fire-calc-progress').textContent = `${result.progress_pct.toFixed(1)}%`;
  } catch (error) {
    console.error('Error calculating FIRE:', error);
    showToast('Failed to calculate FIRE number', 'error');
  }
}

// Add Position Modal
async function showAddPositionModal() {
  document.getElementById('add-position-modal').style.display = 'flex';
  document.getElementById('position-type').value = 'equity';
  togglePositionTypeFields();
  await loadAccountsForSelect();
  await loadAccountTypesForSelect();
}

function hideAddPositionModal() {
  document.getElementById('add-position-modal').style.display = 'none';
  document.getElementById('new-account-form').style.display = 'none';
  document.getElementById('add-position-form').reset();
}

function togglePositionTypeFields() {
  const posType = document.getElementById('position-type').value;

  document.getElementById('stock-fields').style.display = posType === 'equity' || posType === 'fund' ? 'block' : 'none';
  document.getElementById('cash-fields').style.display = posType === 'cash' ? 'block' : 'none';
  document.getElementById('cd-fields').style.display = posType === 'cd' ? 'block' : 'none';
  document.getElementById('real-estate-fields').style.display = posType === 'real_estate' ? 'block' : 'none';
}

async function loadAccountsForSelect() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/accounts`);
    const accounts = await response.json();

    const select = document.getElementById('position-account');
    select.innerHTML = '';

    if (accounts.length === 0) {
      select.innerHTML = '<option value="">-- Create an account first --</option>';
    } else {
      accounts.forEach((acc) => {
        const option = document.createElement('option');
        option.value = acc.id;
        option.textContent = `${acc.name} (${acc.brokerage})`;
        select.appendChild(option);
      });
    }
  } catch (error) {
    console.error('Error loading accounts:', error);
  }
}

async function loadAccountTypesForSelect() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/account-types`);
    const types = await response.json();

    const select = document.getElementById('new-account-type');
    select.innerHTML = '';

    types.forEach((type) => {
      const option = document.createElement('option');
      option.value = type.value;
      option.textContent = type.label;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading account types:', error);
  }
}

function showNewAccountForm() {
  const form = document.getElementById('new-account-form');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function createNewAccount() {
  const name = document.getElementById('new-account-name').value.trim();
  const accountType = document.getElementById('new-account-type').value;
  const brokerage = document.getElementById('new-account-brokerage').value.trim() || 'other';

  if (!name) {
    showToast('Please enter an account name', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/portfolio/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        account_type: accountType,
        brokerage: brokerage,
      }),
    });

    const result = await response.json();

    await loadAccountsForSelect();
    document.getElementById('position-account').value = result.id;

    document.getElementById('new-account-form').style.display = 'none';
    document.getElementById('new-account-name').value = '';
    document.getElementById('new-account-brokerage').value = '';

    showToast(`Account "${name}" created`, 'success');
  } catch (error) {
    console.error('Error creating account:', error);
    showToast('Failed to create account', 'error');
  }
}

async function addManualPosition(event) {
  event.preventDefault();

  let accountId = document.getElementById('position-account').value;

  // Check if new account form is visible and has data - auto-create if so
  const newAccountForm = document.getElementById('new-account-form');
  const newAccountName = document.getElementById('new-account-name').value.trim();

  if (newAccountForm.style.display !== 'none' && newAccountName) {
    // Auto-create the new account first
    const accountType = document.getElementById('new-account-type').value;
    const brokerage = document.getElementById('new-account-brokerage').value.trim() || 'other';

    try {
      const response = await fetch(`${API_BASE}/api/portfolio/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newAccountName,
          account_type: accountType,
          brokerage: brokerage,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        showToast(`Account "${newAccountName}" created`, 'success');
        accountId = result.id;
        // Hide the form and refresh dropdown
        newAccountForm.style.display = 'none';
        await loadAccountsForSelect();
        document.getElementById('position-account').value = accountId;
      } else {
        showToast(`Error creating account: ${result.detail || 'Unknown error'}`, 'error');
        return;
      }
    } catch (error) {
      console.error('Error auto-creating account:', error);
      showToast('Failed to create account', 'error');
      return;
    }
  }

  if (!accountId) {
    showToast('Please select an account first', 'error');
    return;
  }

  const posType = document.getElementById('position-type').value;

  try {
    let response;

    if (posType === 'cash') {
      // Add cash position
      const amount = parseFloat(document.getElementById('cash-amount').value);
      const name = document.getElementById('cash-name').value || 'Cash';
      const apyInput = document.getElementById('cash-apy').value;
      const apy = apyInput ? parseFloat(apyInput) / 100 : null;

      if (!amount) {
        showToast('Please enter a cash amount', 'error');
        return;
      }

      const cashData = {
        account_id: accountId,
        amount: amount,
        name: name,
      };
      if (apy !== null) {
        cashData.interest_rate = apy;
      }

      response = await fetch(`${API_BASE}/api/portfolio/positions/cash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cashData),
      });
    } else if (posType === 'cd') {
      // Add CD position
      const amount = parseFloat(document.getElementById('cd-amount').value);
      const name = document.getElementById('cd-name').value;
      const rate = parseFloat(document.getElementById('cd-rate').value) / 100;
      const maturity = document.getElementById('cd-maturity').value;

      if (!amount || !name || !rate || !maturity) {
        showToast('Please fill in all CD fields', 'error');
        return;
      }

      response = await fetch(`${API_BASE}/api/portfolio/positions/cd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          amount: amount,
          name: name,
          interest_rate: rate,
          maturity_date: maturity,
        }),
      });
    } else if (posType === 'real_estate') {
      // Add real estate position
      const name = document.getElementById('re-name').value.trim();
      const currentValue = parseFloat(document.getElementById('re-value').value);
      const costBasis = parseFloat(document.getElementById('re-cost').value);
      const purchaseDate = document.getElementById('re-purchase-date').value || null;

      if (!name || !currentValue || !costBasis) {
        showToast('Please fill in property name, current value, and cost basis', 'error');
        return;
      }

      const reData = {
        account_id: accountId,
        name: name,
        current_value: currentValue,
        cost_basis: costBasis,
      };
      if (purchaseDate) {
        reData.purchase_date = purchaseDate;
      }

      response = await fetch(`${API_BASE}/api/portfolio/positions/real-estate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reData),
      });
    } else {
      // Add stock/fund position
      const ticker = document.getElementById('position-ticker').value.trim().toUpperCase();
      const name = document.getElementById('position-name').value.trim() || null;
      const shares = parseFloat(document.getElementById('position-shares').value);
      const price = document.getElementById('position-price').value
        ? parseFloat(document.getElementById('position-price').value)
        : null;
      const costBasis = document.getElementById('position-cost-basis').value
        ? parseFloat(document.getElementById('position-cost-basis').value)
        : null;
      const isFund = posType === 'fund';

      if (!ticker || !shares) {
        showToast('Please enter ticker and shares', 'error');
        return;
      }

      response = await fetch(`${API_BASE}/api/portfolio/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          ticker: ticker,
          shares: shares,
          name: name,
          current_price: price,
          cost_basis: costBasis,
          is_fund: isFund,
          position_type: posType,
        }),
      });
    }

    const result = await response.json();

    if (response.ok) {
      showToast(result.message || 'Position added', 'success');
      hideAddPositionModal();
      refreshData();
    } else {
      showToast(`Error: ${result.detail || 'Failed to add position'}`, 'error');
    }
  } catch (error) {
    console.error('Error adding position:', error);
    showToast('Failed to add position', 'error');
  }
}

// ==================== File Import Functions ====================

// Store parsed import data
let pendingImportData = null;

// Handle drag over event
function handleDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.add('drag-over');
}

// Handle drag leave event
function handleDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('drag-over');
}

// Handle file drop
async function handleFileDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('drag-over');

  const files = event.dataTransfer.files;
  if (files.length > 0) {
    await processImportFile(files[0]);
  }
}

// Handle file select from input
async function handleFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) {
    await processImportFile(files[0]);
  }
  // Reset input so same file can be selected again
  event.target.value = '';
}

// Process the imported file
async function processImportFile(file) {
  const validTypes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  const validExtensions = ['.csv', '.xls', '.xlsx'];

  const hasValidExt = validExtensions.some((ext) => file.name.toLowerCase().endsWith(ext));
  if (!hasValidExt && !validTypes.includes(file.type)) {
    showToast('Please upload a CSV or Excel file', 'error');
    return;
  }

  // Show processing status
  const statusDiv = document.getElementById('file-import-status');
  const statusText = document.getElementById('file-import-status-text');
  statusDiv.style.display = 'block';
  statusText.textContent = 'Uploading and analyzing file...';

  try {
    // Create form data
    const formData = new FormData();
    formData.append('file', file);

    // Upload and parse file
    const response = await fetch(`${API_BASE}/api/import/parse`, {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.detail || 'Failed to parse file');
    }

    // Store parsed data
    pendingImportData = result;

    // Hide status
    statusDiv.style.display = 'none';

    // Show confirmation modal
    await showImportConfirmModal(file.name, result);
  } catch (error) {
    console.error('Error processing file:', error);
    statusDiv.style.display = 'none';
    showToast(`Error: ${error.message}`, 'error');
  }
}

// Show import confirmation modal
async function showImportConfirmModal(filename, parseResult) {
  // Set filename
  document.querySelector('.import-filename').textContent = filename;

  // Load accounts for select
  await loadImportAccounts();
  await loadImportAccountTypes();

  // Show AI suggestion if available
  const suggestionDiv = document.getElementById('import-account-suggestion');
  const suggestionText = document.getElementById('import-ai-suggestion');

  if (parseResult.suggested_account) {
    suggestionDiv.style.display = 'flex';
    suggestionText.textContent = `AI suggests: ${parseResult.suggested_account.name} (${parseResult.suggested_account.reason})`;

    // Pre-select the suggested account
    const select = document.getElementById('import-account');
    if (parseResult.suggested_account.id) {
      select.value = parseResult.suggested_account.id;
    }
  } else {
    suggestionDiv.style.display = 'none';
  }

  // Populate positions preview table
  const tbody = document.getElementById('import-preview-body');
  tbody.innerHTML = '';

  const positions = parseResult.positions || [];
  document.getElementById('import-position-count').textContent = positions.length;

  positions.forEach((pos, index) => {
    const value = (pos.shares || 0) * (pos.price || 0);
    const row = document.createElement('tr');
    row.innerHTML = `
            <td><input type="checkbox" class="import-position-check" data-index="${index}" checked></td>
            <td>${escapeHtml(pos.ticker || 'N/A')}</td>
            <td>${escapeHtml(pos.name || '-')}</td>
            <td class="text-right">${
              pos.shares ? pos.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '-'
            }</td>
            <td class="text-right">${
              pos.price
                ? '$' + pos.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : '-'
            }</td>
            <td class="text-right">${
              value > 0
                ? '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : '-'
            }</td>
        `;
    tbody.appendChild(row);
  });

  // Show modal
  document.getElementById('import-confirm-modal').style.display = 'flex';
}

// Load accounts for import modal select
async function loadImportAccounts() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/accounts`);
    const accounts = await response.json();

    const select = document.getElementById('import-account');
    select.innerHTML = '';

    if (accounts.length === 0) {
      select.innerHTML = '<option value="">-- Create an account first --</option>';
    } else {
      accounts.forEach((acc) => {
        const option = document.createElement('option');
        option.value = acc.id;
        option.textContent = `${acc.name} (${acc.brokerage})`;
        select.appendChild(option);
      });
    }
  } catch (error) {
    console.error('Error loading accounts:', error);
  }
}

// Load account types for import modal
async function loadImportAccountTypes() {
  try {
    const response = await fetch(`${API_BASE}/api/portfolio/account-types`);
    const types = await response.json();

    const select = document.getElementById('import-new-account-type');
    select.innerHTML = '';

    types.forEach((type) => {
      const option = document.createElement('option');
      option.value = type.value;
      option.textContent = type.label;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading account types:', error);
  }
}

// Hide import modal
function hideImportModal() {
  document.getElementById('import-confirm-modal').style.display = 'none';
  document.getElementById('import-new-account-form').style.display = 'none';
  pendingImportData = null;
}

// Show new account form in import modal
function showImportNewAccountForm() {
  const form = document.getElementById('import-new-account-form');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

// Create account from import modal
async function createImportAccount() {
  const name = document.getElementById('import-new-account-name').value.trim();
  const accountType = document.getElementById('import-new-account-type').value;
  const brokerage = document.getElementById('import-new-account-brokerage').value.trim() || 'other';

  if (!name) {
    showToast('Please enter an account name', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/portfolio/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, account_type: accountType, brokerage }),
    });

    const result = await response.json();

    if (response.ok) {
      showToast('Account created', 'success');
      // Reload accounts and select the new one
      await loadImportAccounts();
      document.getElementById('import-account').value = result.id;
      document.getElementById('import-new-account-form').style.display = 'none';
    } else {
      showToast(`Error: ${result.detail || 'Failed to create account'}`, 'error');
    }
  } catch (error) {
    console.error('Error creating account:', error);
    showToast('Failed to create account', 'error');
  }
}

// Toggle all import position checkboxes
function toggleAllImportPositions() {
  const selectAll = document.getElementById('import-select-all').checked;
  document.querySelectorAll('.import-position-check').forEach((cb) => {
    cb.checked = selectAll;
  });
}

// Confirm and execute import
async function confirmImport() {
  const accountId = document.getElementById('import-account').value;
  if (!accountId) {
    showToast('Please select an account', 'error');
    return;
  }

  if (!pendingImportData || !pendingImportData.positions) {
    showToast('No data to import', 'error');
    return;
  }

  // Get selected positions
  const selectedIndices = [];
  document.querySelectorAll('.import-position-check:checked').forEach((cb) => {
    selectedIndices.push(parseInt(cb.dataset.index));
  });

  if (selectedIndices.length === 0) {
    showToast('Please select at least one position to import', 'error');
    return;
  }

  const selectedPositions = selectedIndices.map((i) => pendingImportData.positions[i]);
  const replaceExisting = document.getElementById('import-replace').checked;

  // Show loading state
  const btn = document.getElementById('confirm-import-btn');
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loading').style.display = 'inline-flex';
  btn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/api/import/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        positions: selectedPositions,
        replace_existing: replaceExisting,
      }),
    });

    const result = await response.json();

    if (response.ok) {
      showToast(`Successfully imported ${result.imported_count} positions`, 'success');
      hideImportModal();
      refreshData();
    } else {
      throw new Error(result.detail || 'Failed to import positions');
    }
  } catch (error) {
    console.error('Error importing positions:', error);
    showToast(`Error: ${error.message}`, 'error');
  } finally {
    // Reset button
    btn.querySelector('.btn-text').style.display = 'inline';
    btn.querySelector('.btn-loading').style.display = 'none';
    btn.disabled = false;
  }
}

// =====================
// Storage Mode & Local Database Functions
// =====================

// Current storage mode: 'server' or 'local'
let currentStorageMode = 'server';

/**
 * Set storage mode (server or local)
 * @param {string} mode - 'server' or 'local'
 * @param {boolean} silent - If true, skip toast notification (used during initialization)
 */
function setStorageMode(mode, silent = false) {
  currentStorageMode = mode;

  // Update UI
  const badge = document.getElementById('storage-mode-badge');
  const localOptions = document.getElementById('local-storage-options');

  badge.textContent = mode === 'server' ? 'Server' : 'Local';
  badge.className = `badge ${mode}`;

  localOptions.style.display = mode === 'local' ? 'block' : 'none';

  // Save preference
  localStorage.setItem('storageMode', mode);

  if (mode === 'local') {
    // Check if we have browser storage data
    checkBrowserStorageData();
  } else {
    // Switch back to server mode - refresh data
    refreshData();
  }

  if (!silent) {
    showToast(`Switched to ${mode} mode`, 'info');
  }
}

/**
 * Check if browser has saved database
 */
async function checkBrowserStorageData() {
  try {
    const hasData = await clientDB.hasIndexedDBData();
    if (hasData) {
      updateLocalDbStatus('Browser storage found - click "Load from Browser" to restore', 'info');
    } else {
      updateLocalDbStatus('No local database loaded. Open a file, create new, or switch to Server mode above.', 'warning');
    }
  } catch (error) {
    console.error('Error checking browser storage:', error);
  }
}

/**
 * Update local database status display
 */
function updateLocalDbStatus(message, type = 'info') {
  const statusEl = document.getElementById('local-db-status');
  const textEl = document.getElementById('local-db-status-text');

  textEl.textContent = message;
  statusEl.className = `info-box ${type}`;

  // Update button states
  const saveBtn = document.getElementById('btn-save-local-db');
  const downloadBtn = document.getElementById('btn-download-local-db');
  const isOpen = clientDB && clientDB.isOpen();

  saveBtn.disabled = !isOpen;
  downloadBtn.disabled = !isOpen;
}

/**
 * Open local database file
 */
async function openLocalDatabase() {
  try {
    if (!clientDB.hasFileSystemAccess()) {
      showToast('File System Access not supported. Use Import instead.', 'warning');
      return;
    }

    const result = await clientDB.openFile();
    if (result) {
      // Disable demo mode if it's currently enabled
      if (currentDemoMode) {
        try {
          await fetch(`${API_BASE}/api/settings/demo-mode`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          });
          // Update UI without page reload
          updateDemoModeUI(false);
        } catch (e) {
          console.log('Demo mode already off or error disabling:', e);
        }
      }

      initLocalAPI();
      updateLocalDbStatus(`Opened: ${result.name} (${formatBytes(result.size)})`, 'success');
      showToast(`Database opened: ${result.name}`, 'success');
      refreshLocalData();
    }
  } catch (error) {
    console.error('Error opening database:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Create new empty local database
 */
async function createNewLocalDatabase() {
  try {
    // Disable demo mode if it's currently enabled
    if (currentDemoMode) {
      try {
        await fetch(`${API_BASE}/api/settings/demo-mode`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        updateDemoModeUI(false);
      } catch (e) {
        console.log('Demo mode already off or error disabling:', e);
      }
    }

    const result = await clientDB.createNew();
    initLocalAPI();
    updateLocalDbStatus('New database created (in memory - save to persist)', 'success');
    showToast('New database created', 'success');
    refreshLocalData();
  } catch (error) {
    console.error('Error creating database:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Save local database to file
 */
async function saveLocalDatabase() {
  try {
    const result = await clientDB.saveToFile();
    if (result.saved) {
      updateLocalDbStatus(`Saved: ${result.name}`, 'success');
      showToast('Database saved', 'success');
    } else if (result.cancelled) {
      showToast('Save cancelled', 'info');
    }
  } catch (error) {
    console.error('Error saving database:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Download local database as file
 */
function downloadLocalDatabase() {
  try {
    const result = clientDB.downloadDatabase();
    showToast(`Downloaded: ${result.name}`, 'success');
  } catch (error) {
    console.error('Error downloading database:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Import database from file input
 */
async function importLocalDatabase(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    // Disable demo mode if it's currently enabled
    if (currentDemoMode) {
      try {
        await fetch(`${API_BASE}/api/settings/demo-mode`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        updateDemoModeUI(false);
      } catch (e) {
        console.log('Demo mode already off or error disabling:', e);
      }
    }

    const result = await clientDB.importFromFile(file);
    initLocalAPI();
    updateLocalDbStatus(`Imported: ${result.name} (${formatBytes(result.size)})`, 'success');
    showToast(`Database imported: ${result.name}`, 'success');
    refreshLocalData();
  } catch (error) {
    console.error('Error importing database:', error);
    showToast(`Error: ${error.message}`, 'error');
  }

  // Reset file input
  event.target.value = '';
}

/**
 * Load database from browser storage (IndexedDB)
 */
async function loadFromBrowserStorage() {
  try {
    const result = await clientDB.loadFromIndexedDB();
    if (result.loaded) {
      // Disable demo mode if it's currently enabled
      if (currentDemoMode) {
        try {
          await fetch(`${API_BASE}/api/settings/demo-mode`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          });
          updateDemoModeUI(false);
        } catch (e) {
          console.log('Demo mode already off or error disabling:', e);
        }
      }

      initLocalAPI();
      updateLocalDbStatus('Loaded from browser storage', 'success');
      showToast('Database loaded from browser', 'success');
      refreshLocalData();
    } else {
      showToast('No saved database found in browser', 'warning');
    }
  } catch (error) {
    console.error('Error loading from browser:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Save database to browser storage (IndexedDB)
 */
async function saveToBrowserStorage() {
  if (!clientDB.isOpen()) {
    showToast('No database open', 'warning');
    return;
  }

  try {
    await clientDB.saveToIndexedDB();
    updateLocalDbStatus('Saved to browser storage', 'success');
    showToast('Database saved to browser', 'success');
  } catch (error) {
    console.error('Error saving to browser:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Clear browser storage
 */
async function clearBrowserStorage() {
  if (!confirm('Are you sure you want to clear the browser database? This cannot be undone.')) {
    return;
  }

  try {
    await clientDB.clearIndexedDB();
    showToast('Browser storage cleared', 'success');
    updateLocalDbStatus('Browser storage cleared', 'info');
  } catch (error) {
    console.error('Error clearing browser storage:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Refresh data from local database
 */
function refreshLocalData() {
  if (!localAPI) {
    console.error('Local API not initialized');
    return;
  }

  try {
    // Get portfolio summary
    const summary = localAPI.getPortfolio();
    updateDashboardWithData(summary, localAPI.getPositions(), localAPI.getAccounts());
    showToast('Local data refreshed', 'success');
  } catch (error) {
    console.error('Error refreshing local data:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Helper to update dashboard with data (works for both server and local mode)
 */
function updateDashboardWithData(summary, positions, accounts) {
  // Update portfolio summary stats
  const totalValueEl = document.getElementById('total-value');
  const gainLossEl = document.getElementById('total-gain-loss');
  const accountCountEl = document.getElementById('account-count');
  const positionCountEl = document.getElementById('position-count');

  if (totalValueEl) totalValueEl.textContent = formatCurrency(summary.total_value);
  if (gainLossEl) {
    gainLossEl.textContent = formatCurrency(summary.total_gain_loss);
    if (summary.total_gain_loss >= 0) {
      gainLossEl.classList.remove('text-error');
      gainLossEl.classList.add('text-success');
    } else {
      gainLossEl.classList.remove('text-success');
      gainLossEl.classList.add('text-error');
    }
  }
  if (accountCountEl) accountCountEl.textContent = summary.account_count;
  if (positionCountEl) positionCountEl.textContent = summary.position_count;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Initialize storage mode from saved preference
 */
function initStorageMode() {
  const savedMode = localStorage.getItem('storageMode') || 'server';
  const radioEl = document.querySelector(`input[name="storage-mode"][value="${savedMode}"]`);
  if (radioEl) {
    radioEl.checked = true;
    if (savedMode === 'local') {
      // Use silent=true to avoid showing toast on every page load
      setStorageMode('local', true);
    }
  }
}

// =====================
// Collapsible Config Panel Functions
// =====================

function toggleConfigPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.classList.toggle('collapsed');
    // Save state to localStorage
    const isCollapsed = panel.classList.contains('collapsed');
    localStorage.setItem(`config-panel-${panelId}`, isCollapsed ? 'collapsed' : 'expanded');
  }
}

function initConfigPanels() {
  // Restore saved panel states
  document.querySelectorAll('.config-panel').forEach((panel) => {
    const savedState = localStorage.getItem(`config-panel-${panel.id}`);
    if (savedState === 'collapsed') {
      panel.classList.add('collapsed');
    }
  });
  // Initialize summaries
  updateTaxConfigSummary();
  updateMonteCarloConfigSummary();
}

function updateTaxConfigSummary() {
  const currentAge = document.getElementById('tax-current-age')?.value || '35';
  const retireAge = document.getElementById('tax-retirement-age')?.value || '65';
  const spending = document.getElementById('tax-annual-spending')?.value || '60000';
  const spendingFormatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(spending);

  const summary = document.getElementById('tax-config-summary');
  if (summary) {
    summary.textContent = `| Age ${currentAge}→${retireAge} | ${spendingFormatted}/yr`;
  }
}

function updateMonteCarloConfigSummary() {
  const currentAge = document.getElementById('current-age')?.value || '35';
  const retireAge = document.getElementById('retirement-age')?.value || '65';
  const contribution = document.getElementById('monthly-contribution')?.value || '2000';
  const withdrawal = document.getElementById('monthly-withdrawal')?.value || '8000';

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  const summary = document.getElementById('monte-carlo-config-summary');
  if (summary) {
    summary.textContent = `| Age ${currentAge}→${retireAge} | +${formatter.format(
      contribution
    )}/mo | -${formatter.format(withdrawal)}/mo`;
  }
}

// =====================
// Tax Projection Functions
// =====================

async function runTaxProjection(event) {
  event.preventDefault();

  // Validate required fields before running
  const requiredFields = [
    { id: 'tax-current-age', name: 'Current Age' },
    { id: 'tax-retirement-age', name: 'Retirement Age' },
    { id: 'tax-end-age', name: 'End Age' },
    { id: 'tax-annual-spending', name: 'Annual Spending' },
    { id: 'tax-expected-return', name: 'Expected Return' },
    { id: 'tax-inflation-rate', name: 'Inflation Rate' },
    { id: 'tax-contrib-traditional', name: 'Traditional %' },
    { id: 'tax-contrib-roth', name: 'Roth %' },
    { id: 'tax-contrib-taxable', name: 'Taxable %' },
    { id: 'tax-federal-rate', name: 'Federal Tax Rate' },
    { id: 'tax-state-rate', name: 'State Tax Rate' },
    { id: 'tax-capgains-rate', name: 'Capital Gains Rate' },
    { id: 'tax-cost-basis', name: 'Cost Basis %' },
  ];

  const missingFields = [];
  for (const field of requiredFields) {
    const el = document.getElementById(field.id);
    if (!el || el.value === '' || el.value === null || isNaN(parseFloat(el.value))) {
      missingFields.push(field.name);
    }
  }

  if (missingFields.length > 0) {
    showToast(
      `Please fill in all required fields: ${missingFields.slice(0, 3).join(', ')}${
        missingFields.length > 3 ? '...' : ''
      }`,
      'error'
    );
    return;
  }

  showLoading('Running tax projection...', true);
  const form = event.target;
  form.classList.add('loading');

  const params = {
    current_age: parseInt(document.getElementById('tax-current-age').value),
    retirement_age: parseInt(document.getElementById('tax-retirement-age').value),
    end_age: parseInt(document.getElementById('tax-end-age').value),
    annual_spending: parseFloat(document.getElementById('tax-annual-spending').value),
    expected_return: parseFloat(document.getElementById('tax-expected-return').value) / 100,
    inflation_rate: parseFloat(document.getElementById('tax-inflation-rate').value) / 100,
    // Pre-retirement contributions
    monthly_contribution: parseFloat(document.getElementById('tax-monthly-contribution').value) || 0,
    contribution_to_traditional_pct: parseFloat(document.getElementById('tax-contrib-traditional').value) / 100,
    contribution_to_roth_pct: parseFloat(document.getElementById('tax-contrib-roth').value) / 100,
    contribution_to_taxable_pct: parseFloat(document.getElementById('tax-contrib-taxable').value) / 100,
    // Tax rates
    federal_tax_rate: parseFloat(document.getElementById('tax-federal-rate').value) / 100,
    state_tax_rate: parseFloat(document.getElementById('tax-state-rate').value) / 100,
    capital_gains_rate: parseFloat(document.getElementById('tax-capgains-rate').value) / 100,
    cost_basis_ratio: parseFloat(document.getElementById('tax-cost-basis').value) / 100,
  };

  // Get optional balances (leave null if empty to auto-fill from portfolio)
  const taxableBalance = document.getElementById('tax-taxable-balance').value;
  const traditionalBalance = document.getElementById('tax-traditional-balance').value;
  const rothBalance = document.getElementById('tax-roth-balance').value;

  if (taxableBalance) params.taxable_balance = parseFloat(taxableBalance);
  if (traditionalBalance) params.traditional_balance = parseFloat(traditionalBalance);
  if (rothBalance) params.roth_balance = parseFloat(rothBalance);

  try {
    // Use runAsyncApiCall to handle both sync and async (Heroku) responses
    const result = await runAsyncApiCall(
      '/api/projections/tax-projection',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      {
        onProgress: (task) => {
          if (task.progress_message) {
            showToast(task.progress_message, 'info');
          }
        },
      }
    );

    displayTaxProjectionResults(result);
    showToast('Tax projection complete', 'success');
  } catch (error) {
    console.error('Error running tax projection:', error);
    showToast(`Error: ${error.message}`, 'error');
  } finally {
    form.classList.remove('loading');
    hideLoading();
  }
}

function displayTaxProjectionResults(result) {
  // Validate result has required data
  if (!result || !result.summary) {
    showToast('Tax projection returned invalid data', 'error');
    console.error('Invalid tax projection result:', result);
    return;
  }

  // Get input parameters for context
  const currentAge = parseInt(document.getElementById('tax-current-age').value);
  const retirementAge = parseInt(document.getElementById('tax-retirement-age').value);
  const endAge = parseInt(document.getElementById('tax-end-age').value);
  const stateRate = parseFloat(document.getElementById('tax-state-rate').value);
  const federalRate = parseFloat(document.getElementById('tax-federal-rate').value);
  const monthlyContrib = parseFloat(document.getElementById('tax-monthly-contribution').value) || 0;
  const accumulationYears = retirementAge - currentAge;
  const withdrawalYears = endAge - retirementAge;

  // Update context banner
  const contextPeriod = document.getElementById('tax-context-period');
  const contextYears = document.getElementById('tax-context-years');
  if (contextPeriod) {
    if (accumulationYears > 0) {
      contextPeriod.textContent = `Age ${currentAge} → ${retirementAge} → ${endAge}`;
    } else {
      contextPeriod.textContent = `Age ${retirementAge} → ${endAge}`;
    }
  }
  if (contextYears) {
    if (accumulationYears > 0 && monthlyContrib > 0) {
      contextYears.textContent = `${accumulationYears}yr accumulation + ${withdrawalYears}yr`;
    } else {
      contextYears.textContent = `${withdrawalYears} years`;
    }
  }

  // Update summary stats
  document.getElementById('tax-total-federal').textContent = formatCurrency(result.summary.total_federal_tax);
  document.getElementById('tax-total-state').textContent = formatCurrency(result.summary.total_state_tax);
  document.getElementById('tax-total-all').textContent = formatCurrency(result.summary.total_tax);
  document.getElementById('tax-avg-rate').textContent = `${result.summary.average_effective_rate.toFixed(1)}%`;
  // Show gross withdrawals (before tax) - what users actually withdrew from accounts
  const grossWithdrawn = result.summary.total_gross_withdrawn || result.summary.total_withdrawn;
  document.getElementById('tax-total-withdrawn').textContent = formatCurrency(grossWithdrawn);
  document.getElementById('tax-final-balance').textContent = formatCurrency(result.summary.final_balance);

  // Update detail descriptions
  const federalDetail = document.getElementById('tax-federal-detail');
  if (federalDetail) {
    const avgAnnualFederal = result.summary.total_federal_tax / withdrawalYears;
    federalDetail.textContent = `~${formatCurrency(avgAnnualFederal)}/yr at ${federalRate}% marginal rate`;
  }

  const stateDetail = document.getElementById('tax-state-detail');
  const stateRateDisplay = document.getElementById('tax-state-rate-display');
  if (stateRateDisplay) stateRateDisplay.textContent = `${stateRate}%`;
  if (stateDetail && stateRate === 0) {
    stateDetail.textContent = 'No state income tax configured';
  }

  const totalDetail = document.getElementById('tax-total-detail');
  if (totalDetail) {
    // Use gross withdrawals for accurate percentage (tax / gross, not tax / net)
    const grossWithdrawn = result.summary.total_gross_withdrawn || result.summary.total_withdrawn;
    const taxAsPercent = grossWithdrawn > 0 ? ((result.summary.total_tax / grossWithdrawn) * 100).toFixed(1) : '0.0';
    totalDetail.textContent = `${taxAsPercent}% of gross withdrawals over ${withdrawalYears} years`;
  }

  const withdrawnDetail = document.getElementById('tax-withdrawn-detail');
  if (withdrawnDetail) {
    // Show gross withdrawals (before tax) in detail
    const grossWithdrawn = result.summary.total_gross_withdrawn || result.summary.total_withdrawn;
    const avgAnnualWithdrawal = grossWithdrawn / withdrawalYears;
    withdrawnDetail.textContent = `~${formatCurrency(avgAnnualWithdrawal)}/yr from all account types`;
  }

  const balanceDetail = document.getElementById('tax-balance-detail');
  const balanceCard = document.querySelector('.tax-stat-balance');
  if (balanceCard) {
    balanceCard.classList.remove('depleted', 'healthy');
    if (result.summary.final_balance <= 0) {
      balanceCard.classList.add('depleted');
      if (balanceDetail) balanceDetail.textContent = 'Portfolio depleted before end of projection';
    } else if (result.summary.final_balance > result.summary.total_withdrawn * 0.1) {
      balanceCard.classList.add('healthy');
      if (balanceDetail) balanceDetail.textContent = 'Healthy balance remaining for legacy/emergencies';
    } else {
      if (balanceDetail) balanceDetail.textContent = 'Remaining at end of projection';
    }
  }

  // Render charts
  renderTaxBurdenChart(result.chart_data);
  renderAccountBalanceChart(result.chart_data);

  // Render withdrawal table
  renderTaxWithdrawalTable(result.years);
}

function renderTaxBurdenChart(chartData) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  const traces = [
    {
      x: chartData.ages,
      y: chartData.federal_taxes,
      type: 'bar',
      name: 'Federal Tax',
      marker: { color: '#3b82f6' },
    },
    {
      x: chartData.ages,
      y: chartData.state_taxes,
      type: 'bar',
      name: 'State Tax',
      marker: { color: '#8b5cf6' },
    },
    {
      x: chartData.ages,
      y: chartData.effective_rates,
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Effective Rate (%)',
      yaxis: 'y2',
      line: { color: '#f59e0b', width: 2 },
      marker: { size: 4 },
    },
  ];

  const layout = {
    barmode: 'stack',
    showlegend: true,
    legend: {
      orientation: 'h',
      y: -0.15,
    },
    xaxis: {
      title: 'Age',
      color: isDark ? '#a3a3a3' : '#666',
    },
    yaxis: {
      title: 'Tax Amount',
      color: isDark ? '#a3a3a3' : '#666',
      tickprefix: '$',
      tickformat: '.2s', // SI notation: 60K instead of 60,000
    },
    yaxis2: {
      title: 'Effective Rate (%)',
      overlaying: 'y',
      side: 'right',
      color: isDark ? '#a3a3a3' : '#666',
      ticksuffix: '%',
      range: [0, Math.max(...chartData.effective_rates.filter((r) => r > 0), 30) * 1.2],
    },
    margin: { t: 20, r: 60, b: 60, l: 60 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: isDark ? '#e5e5e5' : '#1a1a1a' },
    hoverlabel: {
      bgcolor: isDark ? '#1e1e1e' : '#ffffff',
      font: { color: isDark ? '#e0e0e0' : '#1e1e1e' },
      bordercolor: isDark ? '#404040' : '#e0e0e0',
    },
  };

  Plotly.newPlot('tax-burden-chart', traces, layout, {
    responsive: true,
    displayModeBar: false,
  });
}

function renderAccountBalanceChart(chartData) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  const traces = [
    {
      x: chartData.ages,
      y: chartData.taxable_balances,
      type: 'scatter',
      mode: 'lines',
      name: 'Taxable',
      line: { color: '#22c55e', width: 2 },
      fill: 'tozeroy',
      fillcolor: 'rgba(34, 197, 94, 0.1)',
    },
    {
      x: chartData.ages,
      y: chartData.traditional_balances,
      type: 'scatter',
      mode: 'lines',
      name: 'Traditional (IRA/401k)',
      line: { color: '#f97316', width: 2 },
      fill: 'tozeroy',
      fillcolor: 'rgba(249, 115, 22, 0.1)',
    },
    {
      x: chartData.ages,
      y: chartData.roth_balances,
      type: 'scatter',
      mode: 'lines',
      name: 'Roth',
      line: { color: '#06b6d4', width: 2 },
      fill: 'tozeroy',
      fillcolor: 'rgba(6, 182, 212, 0.1)',
    },
    {
      x: chartData.ages,
      y: chartData.total_balances,
      type: 'scatter',
      mode: 'lines',
      name: 'Total',
      line: { color: isDark ? '#ffffff' : '#1a1a1a', width: 2, dash: 'dash' },
    },
  ];

  const layout = {
    showlegend: true,
    legend: {
      orientation: 'h',
      y: -0.15,
    },
    xaxis: {
      title: 'Age',
      color: isDark ? '#a3a3a3' : '#666',
    },
    yaxis: {
      title: 'Balance',
      color: isDark ? '#a3a3a3' : '#666',
      tickprefix: '$',
      tickformat: '.2s', // SI notation: 60M instead of 60,000,000
    },
    margin: { t: 20, r: 20, b: 60, l: 60 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: isDark ? '#e5e5e5' : '#1a1a1a' },
    hoverlabel: {
      bgcolor: isDark ? '#1e1e1e' : '#ffffff',
      font: { color: isDark ? '#e0e0e0' : '#1e1e1e' },
      bordercolor: isDark ? '#404040' : '#e0e0e0',
    },
  };

  Plotly.newPlot('tax-balance-chart', traces, layout, {
    responsive: true,
    displayModeBar: false,
  });
}

function renderTaxWithdrawalTable(years) {
  const tbody = document.querySelector('#tax-withdrawal-table tbody');

  // Clear existing rows
  while (tbody.firstChild) {
    tbody.removeChild(tbody.firstChild);
  }

  if (!years || years.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
    cell.className = 'text-muted';
    cell.textContent = 'No data available';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  // Filter to only show retirement years (withdrawal phase)
  const retirementYears = years.filter((year) => year.phase === 'withdrawal');

  if (retirementYears.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
    cell.className = 'text-muted';
    cell.textContent = 'No retirement years in projection';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  retirementYears.forEach((year) => {
    const row = document.createElement('tr');

    const cells = [
      year.age.toString(),
      formatCurrency(year.total_balance),
      year.rmd_amount > 0 ? formatCurrency(year.rmd_amount) : '-',
      year.from_taxable > 0 ? formatCurrency(year.from_taxable) : '-',
      year.from_traditional > 0 ? formatCurrency(year.from_traditional) : '-',
      year.from_roth > 0 ? formatCurrency(year.from_roth) : '-',
      formatCurrency(year.federal_tax),
      formatCurrency(year.state_tax),
      `${year.effective_rate.toFixed(1)}%`,
      formatCurrency(year.net_withdrawal),
    ];

    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      row.appendChild(td);
    });

    tbody.appendChild(row);
  });
}

// Load taxes tab - auto-fill balances from portfolio
async function loadTaxesTab() {
  try {
    const response = await fetch(`${API_BASE}/api/projections/account-balances-by-type`);
    if (response.ok) {
      const data = await response.json();
      // Only auto-fill if fields are empty (user hasn't entered custom values)
      const taxableEl = document.getElementById('tax-taxable-balance');
      const traditionalEl = document.getElementById('tax-traditional-balance');
      const rothEl = document.getElementById('tax-roth-balance');

      if (!taxableEl.value) taxableEl.placeholder = formatCurrency(data.taxable);
      if (!traditionalEl.value) traditionalEl.placeholder = formatCurrency(data.traditional);
      if (!rothEl.value) rothEl.placeholder = formatCurrency(data.roth);
    }
  } catch (error) {
    console.error('Error loading account balances for taxes tab:', error);
  }
}

// =========================================================================
// BUDGET TAB FUNCTIONS
// =========================================================================

// Budget sub-tab navigation
function showBudgetTab(tabName) {
  // Hide all budget subtabs
  document.querySelectorAll('.budget-subtab').forEach((tab) => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.budget-nav-item').forEach((nav) => {
    nav.classList.remove('active');
  });

  // Show selected subtab
  const subtab = document.getElementById(`budget-${tabName}`);
  if (subtab) {
    subtab.classList.add('active');
  }

  // Activate nav item
  const navItem = document.querySelector(`.budget-nav-item[data-budget-tab="${tabName}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // Load subtab-specific data
  if (tabName === 'cashflow') {
    loadCashFlowData();
  } else if (tabName === 'transition') {
    // Transition chart is loaded on demand
  }
}

// Load budget tab data
async function loadBudgetTab() {
  try {
    await Promise.all([loadTaxConfig(), loadIncomeSources(), loadDeductions(), loadExpenses()]);
    updatePaycheckPreview();
  } catch (error) {
    console.error('Error loading budget tab:', error);
  }
}

// Load tax configuration
async function loadTaxConfig() {
  try {
    const data = await apiCall('/api/budget/tax-config');
    if (data) {
      const filingEl = document.getElementById('filing-status');
      const stateEl = document.getElementById('tax-state');
      if (filingEl && data.filing_status) {
        filingEl.value = data.filing_status;
      }
      if (stateEl && data.state) {
        stateEl.value = data.state;
      }
    }
  } catch (error) {
    console.error('Error loading tax config:', error);
  }
}

// Save tax configuration
async function saveTaxConfig() {
  const filingStatus = document.getElementById('filing-status').value;
  const state = document.getElementById('tax-state').value;

  try {
    await apiCall('/api/budget/tax-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filing_status: filingStatus,
        state: state,
      }),
    });
    updatePaycheckPreview();
  } catch (error) {
    console.error('Error saving tax config:', error);
  }
}

// Update budget calculations when config changes
function updateBudgetCalc() {
  saveTaxConfig();
}

// Load income sources
// Global storage for budget data (for editing)
let budgetIncomeSources = [];
let budgetDeductions = [];
let budgetExpenses = [];

async function loadIncomeSources() {
  try {
    const data = await apiCall('/api/budget/income');
    budgetIncomeSources = data || []; // Store for editing
    const container = document.getElementById('income-sources-list');

    if (!data || data.length === 0) {
      container.innerHTML =
        '<p class="empty-state">No income sources added yet. Click "Add Income" to get started.</p>';
      return;
    }

    container.innerHTML = data
      .map(
        (income) => `
            <div class="income-item">
                <div class="income-item-info">
                    <div class="income-item-name">${escapeHtml(income.name)}</div>
                    <div class="income-item-details">
                        ${formatIncomeType(income.income_type)} • ${formatPayFrequency(income.pay_frequency)} • ${
          income.state
        }
                    </div>
                </div>
                <div class="income-item-amount">${formatCurrency(income.gross_annual)}/yr</div>
                <div class="income-item-actions">
                    <button class="btn btn-sm btn-default" onclick="editIncome('${income.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteIncome('${income.id}')">Delete</button>
                </div>
            </div>
        `
      )
      .join('');
  } catch (error) {
    console.error('Error loading income sources:', error);
  }
}

// Load pre-tax deductions
async function loadDeductions() {
  try {
    const data = await apiCall('/api/budget/deductions');
    budgetDeductions = data || []; // Store for editing
    const container = document.getElementById('deductions-list');

    if (!data || data.length === 0) {
      container.innerHTML = '<p class="empty-state">No pre-tax deductions. Add 401k, HSA, FSA contributions here.</p>';
      return;
    }

    container.innerHTML = data
      .map((ded) => {
        // Show label prominently if it exists, otherwise show deduction type
        const displayName = ded.label
          ? `${escapeHtml(ded.label)} (${formatDeductionType(ded.deduction_type)})`
          : formatDeductionType(ded.deduction_type);
        return `
            <div class="deduction-item">
                <div class="deduction-item-info">
                    <div class="deduction-item-name">${displayName}</div>
                    <div class="deduction-item-details">
                        ${
                          ded.is_percentage
                            ? ded.amount_per_period + '% of gross'
                            : formatCurrency(ded.amount_per_period) + '/period'
                        }
                        ${ded.employer_match > 0 ? ' + ' + formatCurrency(ded.employer_match) + ' employer match' : ''}
                    </div>
                </div>
                <div class="deduction-item-amount">${formatCurrency(ded.annual_amount || ded.amount_per_period * 26)}/yr</div>
                <div class="deduction-item-actions">
                    <button class="btn btn-sm btn-default" onclick="editDeduction('${ded.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteDeduction('${ded.id}')">Delete</button>
                </div>
            </div>
        `;
      })
      .join('');
  } catch (error) {
    console.error('Error loading deductions:', error);
  }
}

// Load expenses
async function loadExpenses() {
  try {
    const data = await apiCall('/api/budget/expenses');
    budgetExpenses = data || []; // Store for editing
    const container = document.getElementById('expenses-list');

    if (!data || data.length === 0) {
      container.innerHTML =
        '<p class="empty-state">No expenses added yet. Click "Add Expense" to track your spending.</p>';
      return;
    }

    container.innerHTML = data
      .map(
        (exp) => `
            <div class="expense-item">
                <div class="expense-item-info">
                    <div class="expense-item-name">${escapeHtml(exp.name)}</div>
                    <div class="expense-item-details">
                        ${exp.category_name || 'Uncategorized'} • ${formatExpenseFrequency(exp.frequency)}
                    </div>
                </div>
                <div class="expense-item-amount">${formatCurrency(exp.monthly_amount)}/mo</div>
                <div class="expense-item-actions">
                    <button class="btn btn-sm btn-default" onclick="editExpense('${exp.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteExpense('${exp.id}')">Delete</button>
                </div>
            </div>
        `
      )
      .join('');

    // Update category chart
    updateExpensesCategoryChart(data);
  } catch (error) {
    console.error('Error loading expenses:', error);
  }
}

// Track selected income source for paycheck preview
let selectedPaycheckIncomeIndex = 0;

// Update paycheck preview
async function updatePaycheckPreview(incomeIndex = null) {
  try {
    const incomeData = await apiCall('/api/budget/income');
    const container = document.getElementById('paycheck-breakdown');

    if (!incomeData || incomeData.length === 0) {
      container.innerHTML = '<p class="empty-state">Add income to see paycheck breakdown.</p>';
      return;
    }

    // Use provided index or default to selected
    if (incomeIndex !== null) {
      selectedPaycheckIncomeIndex = incomeIndex;
    }
    // Ensure index is valid
    if (selectedPaycheckIncomeIndex >= incomeData.length) {
      selectedPaycheckIncomeIndex = 0;
    }

    // Build income switcher if multiple sources (data is user's own input from their database)
    let switcherHtml = '';
    if (incomeData.length > 1) {
      const buttons = incomeData.map((inc, idx) => {
        const activeClass = idx === selectedPaycheckIncomeIndex ? 'active' : '';
        const safeName = String(inc.name || 'Income ' + (idx + 1)).replace(/[<>&"']/g, '');
        return `<button class="paycheck-income-btn ${activeClass}" onclick="updatePaycheckPreview(${idx})">${safeName}</button>`;
      }).join('');
      switcherHtml = `<div class="paycheck-income-switcher">${buttons}</div>`;
    }

    // Calculate paycheck for selected income source
    const primaryIncome = incomeData[selectedPaycheckIncomeIndex];
    const filingStatus = document.getElementById('filing-status')?.value || 'single';
    const state = document.getElementById('tax-state')?.value || primaryIncome.state || 'CA';

    // Convert annual to per-period based on pay frequency
    const periodsPerYear = {
      weekly: 52,
      biweekly: 26,
      semimonthly: 24,
      monthly: 12,
    };
    const periods = periodsPerYear[primaryIncome.pay_frequency] || 26;
    const grossPerPeriod = primaryIncome.gross_annual / periods;

    // Get deductions for this income source
    const deductions = await apiCall('/api/budget/deductions');
    let pretax401k = 0,
      pretaxHsa = 0,
      pretaxFsa = 0,
      pretaxOther = 0;

    if (deductions && deductions.length > 0) {
      for (const ded of deductions) {
        if (ded.deduction_type === '401k') pretax401k = ded.amount_per_period || 0;
        else if (ded.deduction_type === 'hsa') pretaxHsa = ded.amount_per_period || 0;
        else if (ded.deduction_type === 'fsa') pretaxFsa = ded.amount_per_period || 0;
        else pretaxOther += ded.amount_per_period || 0;
      }
    }

    const paycheck = await apiCall('/api/budget/calculate-paycheck', {
      method: 'POST',
      body: {
        gross_per_period: grossPerPeriod,
        pay_frequency: primaryIncome.pay_frequency,
        filing_status: filingStatus,
        state: state,
        pretax_401k: pretax401k,
        pretax_hsa: pretaxHsa,
        pretax_fsa: pretaxFsa,
        pretax_other: pretaxOther,
      },
    });

    if (paycheck) {
      // Map API field names to expected names
      const grossPay = paycheck.gross || 0;
      const socialSecurity = paycheck.social_security || 0;
      const medicare = paycheck.medicare + (paycheck.additional_medicare || 0);
      const pretaxDeductions = paycheck.total_pretax_deductions || 0;
      const totalTaxes = paycheck.total_taxes || 0;

      // Calculate effective tax rate (total taxes / gross)
      const effectiveTaxRate = grossPay > 0 ? (totalTaxes / grossPay) * 100 : 0;
      // Marginal federal rate approximation based on income (simplified)
      const annualGross = grossPay * (periodsPerYear[primaryIncome.pay_frequency] || 26);
      const marginalRate =
        annualGross > 578125
          ? 37
          : annualGross > 231250
          ? 35
          : annualGross > 182100
          ? 32
          : annualGross > 95375
          ? 24
          : annualGross > 44725
          ? 22
          : annualGross > 11000
          ? 12
          : 10;

      container.innerHTML = `
                ${switcherHtml}
                <div class="paycheck-tax-rates-callout">
                    <div class="tax-rate-item">
                        <span class="tax-rate-label">Effective Tax Rate</span>
                        <span class="tax-rate-value">${effectiveTaxRate.toFixed(1)}%</span>
                    </div>
                    <div class="tax-rate-item">
                        <span class="tax-rate-label">Marginal Federal Rate</span>
                        <span class="tax-rate-value">${marginalRate}%</span>
                    </div>
                </div>
                <div class="paycheck-breakdown-grid">
                    <div class="paycheck-section">
                        <h4>Earnings</h4>
                        <div class="paycheck-line">
                            <span class="label">Gross Pay</span>
                            <span class="amount">${formatCurrency(grossPay)}</span>
                        </div>
                    </div>
                    <div class="paycheck-section">
                        <h4>Deductions</h4>
                        <div class="paycheck-line">
                            <span class="label">Federal Income Tax</span>
                            <span class="amount negative">-${formatCurrency(paycheck.federal_income_tax || 0)}</span>
                        </div>
                        <div class="paycheck-line">
                            <span class="label">State Income Tax</span>
                            <span class="amount negative">-${formatCurrency(paycheck.state_income_tax || 0)}</span>
                        </div>
                        <div class="paycheck-line">
                            <span class="label">Social Security</span>
                            <span class="amount negative">-${formatCurrency(socialSecurity)}</span>
                        </div>
                        <div class="paycheck-line">
                            <span class="label">Medicare</span>
                            <span class="amount negative">-${formatCurrency(medicare)}</span>
                        </div>
                        <div class="paycheck-line">
                            <span class="label">Pre-tax Deductions</span>
                            <span class="amount negative">-${formatCurrency(pretaxDeductions)}</span>
                        </div>
                        <div class="paycheck-line total">
                            <span class="label">Net Pay</span>
                            <span class="amount positive">${formatCurrency(paycheck.net_pay || 0)}</span>
                        </div>
                    </div>
                </div>
            `;
    }
  } catch (error) {
    console.error('Error updating paycheck preview:', error);
  }
}

// Load cash flow data
async function loadCashFlowData() {
  try {
    // Get tax configuration for the request
    const filingStatus = document.getElementById('filing-status')?.value || 'single';
    const state = document.getElementById('tax-state')?.value || 'CA';

    const summary = await apiCall('/api/budget/calculate-annual', {
      method: 'POST',
      body: {
        filing_status: filingStatus,
        state: state,
        tax_year: new Date().getFullYear(),
      },
    });

    if (summary) {
      // Update stats - handle both property name formats
      const monthlyGross = summary.monthly_gross || summary.gross_income / 12 || 0;
      const monthlyTaxes = summary.total_taxes ? summary.total_taxes / 12 : 0;
      const monthlyNet = summary.monthly_net || summary.net_income / 12 || 0;
      const monthlyExpenses = summary.monthly_expenses || summary.total_expenses / 12 || 0;
      const monthlySavings = summary.monthly_savings || summary.net_savings / 12 || 0;
      const savingsRate = summary.savings_rate || 0;

      document.getElementById('stat-monthly-gross').textContent = formatCurrency(monthlyGross);
      document.getElementById('stat-monthly-taxes').textContent = formatCurrency(monthlyTaxes);
      document.getElementById('stat-monthly-net').textContent = formatCurrency(monthlyNet);
      document.getElementById('stat-monthly-expenses').textContent = formatCurrency(monthlyExpenses);
      document.getElementById('stat-monthly-savings').textContent = formatCurrency(monthlySavings);
      document.getElementById('stat-savings-rate').textContent = savingsRate.toFixed(1) + '%';

      // Load paycheck chart
      await loadPaycheckChart();

      // Load waterfall chart
      renderCashFlowWaterfall(summary);
    }
  } catch (error) {
    console.error('Error loading cash flow data:', error);
  }
}

// Load paycheck chart (cumulative YTD line chart)
async function loadPaycheckChart() {
  try {
    const chartData = await apiCall('/api/budget/paycheck-chart-data');

    if (!chartData || !chartData.periods || chartData.periods.length === 0) {
      document.getElementById('paycheck-chart').innerHTML =
        '<p class="empty-state">Add income to see paycheck breakdown chart.</p>';
      return;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    // Use line chart to show cumulative growth with visible cap plateaus
    const traces = [
      {
        name: 'Gross Income',
        x: chartData.periods,
        y: chartData.gross,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#3b82f6', width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(59, 130, 246, 0.1)',
      },
      {
        name: 'Take-home',
        x: chartData.periods,
        y: chartData.takehome,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#22c55e', width: 2 },
      },
      {
        name: 'Federal Tax',
        x: chartData.periods,
        y: chartData.federal_tax,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#ef4444', width: 2 },
      },
      {
        name: 'State Tax',
        x: chartData.periods,
        y: chartData.state_tax,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#f97316', width: 2 },
      },
      {
        name: 'Social Security',
        x: chartData.periods,
        y: chartData.social_security || chartData.fica,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#eab308', width: 2 },
        hovertemplate: chartData.limits
          ? `Period %{x}<br>YTD SS: $%{y:,.0f}<br>Cap: $${chartData.limits.ss_wage_base.toLocaleString()} wage base<extra></extra>`
          : undefined,
      },
      {
        name: 'Medicare',
        x: chartData.periods,
        y: chartData.medicare || [],
        type: 'scatter',
        mode: 'lines',
        line: { color: '#a855f7', width: 2 },
        visible: chartData.medicare ? true : 'legendonly',
      },
      {
        name: 'Pre-tax (401k/HSA)',
        x: chartData.periods,
        y: chartData.pretax,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#8b5cf6', width: 2, dash: 'dot' },
        hovertemplate: chartData.limits
          ? `Period %{x}<br>YTD Pre-tax: $%{y:,.0f}<br>401k limit: $${chartData.limits.limit_401k.toLocaleString()}<extra></extra>`
          : undefined,
      },
    ];

    // Add annotation for SS wage cap if applicable
    const annotations = [];
    if (chartData.limits && chartData.gross) {
      const finalGross = chartData.gross[chartData.gross.length - 1];
      if (finalGross > chartData.limits.ss_wage_base) {
        // Find period where SS caps out
        const capPeriod = chartData.gross.findIndex((g) => g >= chartData.limits.ss_wage_base) + 1;
        if (capPeriod > 0) {
          annotations.push({
            x: capPeriod,
            y: chartData.social_security ? chartData.social_security[capPeriod - 1] : 0,
            text: 'SS Cap Reached',
            showarrow: true,
            arrowhead: 2,
            ax: 40,
            ay: -30,
            font: { size: 10, color: isDark ? '#fbbf24' : '#92400e' },
          });
        }
      }
    }

    const layout = {
      xaxis: {
        title: 'Pay Period',
        tickmode: 'linear',
        dtick: Math.ceil(chartData.periods.length / 13),
        gridcolor: isDark ? '#303030' : '#f0f0f0',
      },
      yaxis: {
        title: 'Cumulative YTD ($)',
        tickformat: '$,.0f',
        gridcolor: isDark ? '#303030' : '#f0f0f0',
      },
      legend: {
        orientation: 'h',
        y: -0.2,
        font: { color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)' },
      },
      annotations: annotations,
      margin: { t: 20, r: 20, b: 80, l: 70 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor: isDark ? '#1e1e1e' : '#ffffff',
        font: { color: isDark ? '#e0e0e0' : '#1e1e1e' },
        bordercolor: isDark ? '#404040' : '#e0e0e0',
      },
    };

    Plotly.newPlot('paycheck-chart', traces, layout, { responsive: true });
  } catch (error) {
    console.error('Error loading paycheck chart:', error);
  }
}

// Render cash flow waterfall chart
function renderCashFlowWaterfall(summary) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  const trace = {
    type: 'waterfall',
    orientation: 'v',
    x: ['Gross Income', 'Federal Tax', 'State Tax', 'FICA', 'Pre-tax', 'Net Income', 'Expenses', 'Savings'],
    y: [
      summary.gross_income,
      -summary.federal_income_tax,
      -summary.state_income_tax,
      -(summary.social_security_tax + summary.medicare_tax),
      -summary.total_pretax_deductions,
      0, // subtotal
      -summary.total_expenses,
      0, // final total
    ],
    measure: ['absolute', 'relative', 'relative', 'relative', 'relative', 'total', 'relative', 'total'],
    connector: { line: { color: isDark ? '#424242' : 'rgb(63, 63, 63)' } },
    decreasing: { marker: { color: '#ef4444' } },
    increasing: { marker: { color: '#22c55e' } },
    totals: { marker: { color: '#3b82f6' } },
  };

  const layout = {
    xaxis: { gridcolor: isDark ? '#303030' : '#f0f0f0' },
    yaxis: {
      title: 'Annual Amount ($)',
      tickformat: '$,.0f',
      gridcolor: isDark ? '#303030' : '#f0f0f0',
    },
    margin: { t: 20, r: 20, b: 60, l: 80 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
    showlegend: false,
    hoverlabel: {
      bgcolor: isDark ? '#1e1e1e' : '#ffffff',
      font: { color: isDark ? '#e0e0e0' : '#1e1e1e' },
      bordercolor: isDark ? '#404040' : '#e0e0e0',
    },
  };

  Plotly.newPlot('cashflow-waterfall-chart', [trace], layout, { responsive: true });
}

// Update expenses category chart
function updateExpensesCategoryChart(expenses) {
  if (!expenses || expenses.length === 0) {
    document.getElementById('expenses-category-chart').innerHTML =
      '<p class="empty-state">Add expenses to see category breakdown.</p>';
    return;
  }

  // Group by category
  const byCategory = {};
  expenses.forEach((exp) => {
    const cat = exp.category_name || 'Other';
    byCategory[cat] = (byCategory[cat] || 0) + exp.monthly_amount;
  });

  const labels = Object.keys(byCategory);
  const values = Object.values(byCategory);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)';

  const trace = {
    type: 'pie',
    labels: labels,
    values: values,
    hole: 0.4,
    textinfo: 'label+percent',
    textposition: 'outside',
    textfont: { color: textColor },
  };

  const layout = {
    margin: { t: 20, r: 20, b: 20, l: 20 },
    paper_bgcolor: 'transparent',
    font: { color: textColor },
    showlegend: false,
    hoverlabel: {
      bgcolor: isDark ? '#1e1e1e' : '#ffffff',
      font: { color: isDark ? '#e0e0e0' : '#1e1e1e' },
      bordercolor: isDark ? '#404040' : '#e0e0e0',
    },
  };

  Plotly.newPlot('expenses-category-chart', [trace], layout, { responsive: true });
}

// Run retirement transition projection
async function runTransitionProjection() {
  const currentAge = parseInt(document.getElementById('transition-current-age').value) || 35;
  const retirementAge = parseInt(document.getElementById('transition-retirement-age').value) || 65;
  const ssAge = parseInt(document.getElementById('transition-ss-age').value) || 67;
  const endAge = parseInt(document.getElementById('transition-end-age').value) || 95;
  const ssOverride = document.getElementById('ss-override').value
    ? parseFloat(document.getElementById('ss-override').value)
    : null;

  try {
    const data = await apiCall('/api/budget/income-transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_age: currentAge,
        retirement_age: retirementAge,
        ss_claiming_age: ssAge,
        end_age: endAge,
        ss_benefit_override: ssOverride,
      }),
    });

    if (data && data.years) {
      renderTransitionChart(data.years);
      renderSSComparison(data.ss_comparison);
    }
  } catch (error) {
    console.error('Error running transition projection:', error);
    showToast('Error running projection', 'error');
  }
}

// Render income transition chart
function renderTransitionChart(years) {
  const ages = years.map((y) => y.age);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? 'rgba(255, 255, 255, 0.65)' : 'rgba(0, 0, 0, 0.65)';
  const gridColor = isDark ? '#303030' : '#e0e0e0';

  const traces = [
    {
      name: 'Employment Income',
      x: ages,
      y: years.map((y) => y.employment_income),
      type: 'scatter',
      mode: 'none',
      fill: 'tozeroy',
      fillcolor: 'rgba(34, 197, 94, 0.6)',
      stackgroup: 'one',
    },
    {
      name: 'Portfolio Withdrawals',
      x: ages,
      y: years.map((y) => y.withdrawal_needed),
      type: 'scatter',
      mode: 'none',
      fill: 'tonexty',
      fillcolor: 'rgba(59, 130, 246, 0.6)',
      stackgroup: 'one',
    },
    {
      name: 'Social Security',
      x: ages,
      y: years.map((y) => y.ss_income),
      type: 'scatter',
      mode: 'none',
      fill: 'tonexty',
      fillcolor: 'rgba(139, 92, 246, 0.6)',
      stackgroup: 'one',
    },
    {
      name: 'Expenses',
      x: ages,
      y: years.map((y) => y.total_income),
      type: 'scatter',
      mode: 'lines',
      line: { color: '#ef4444', width: 2, dash: 'dash' },
    },
  ];

  const layout = {
    xaxis: {
      title: 'Age',
      titlefont: { color: textColor },
      tickfont: { color: textColor },
      gridcolor: gridColor,
      zerolinecolor: gridColor,
    },
    yaxis: {
      title: 'Annual Amount ($)',
      tickformat: '$,.0f',
      titlefont: { color: textColor },
      tickfont: { color: textColor },
      gridcolor: gridColor,
      zerolinecolor: gridColor,
    },
    legend: { orientation: 'h', y: -0.2, font: { color: textColor } },
    margin: { t: 20, r: 20, b: 80, l: 80 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: textColor },
    hoverlabel: {
      bgcolor: isDark ? '#1e1e1e' : '#ffffff',
      font: { color: isDark ? '#e0e0e0' : '#1e1e1e' },
      bordercolor: isDark ? '#404040' : '#e0e0e0',
    },
  };

  Plotly.newPlot('transition-chart', traces, layout, { responsive: true });
}

// Render Social Security comparison table
function renderSSComparison(ssData) {
  if (!ssData || ssData.length === 0) {
    document.getElementById('ss-comparison-table').innerHTML =
      '<p class="empty-state">No Social Security data available.</p>';
    return;
  }

  const html = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>Claiming Age</th>
                    <th>Monthly Benefit</th>
                    <th>Annual Benefit</th>
                    <th>% of FRA</th>
                </tr>
            </thead>
            <tbody>
                ${ssData
                  .map(
                    (row) => `
                    <tr>
                        <td>${row.claiming_age}</td>
                        <td>${formatCurrency(row.monthly_benefit)}</td>
                        <td>${formatCurrency(row.annual_benefit)}</td>
                        <td>${row.percent_of_fra.toFixed(1)}%</td>
                    </tr>
                `
                  )
                  .join('')}
            </tbody>
        </table>
    `;

  document.getElementById('ss-comparison-table').innerHTML = html;
}

// Modal functions for adding income/expenses/deductions
async function showAddIncomeModal() {
  // Load states from API
  let stateOptions = '<option value="CA">California</option>';
  try {
    const states = await apiCall('/api/budget/states');
    if (states && states.length > 0) {
      stateOptions = states
        .map((s) => {
          const taxInfo = s.type === 'none' ? ' (No income tax)' : '';
          return `<option value="${s.code}">${s.name}${taxInfo}</option>`;
        })
        .join('');
    }
  } catch (e) {
    console.warn('Could not load states, using default');
  }

  const modal = createModal(
    'Add Income Source',
    `
        <div class="form-group">
            <label for="income-name">Name</label>
            <input type="text" id="income-name" placeholder="e.g., Primary Job">
        </div>
        <div class="form-group">
            <label for="income-type">Type</label>
            <select id="income-type">
                <option value="employment">Employment (W-2)</option>
                <option value="self_employment">Self-Employment (1099)</option>
                <option value="rental">Rental Income</option>
                <option value="investment">Investment Income</option>
                <option value="other">Other</option>
            </select>
        </div>
        <div class="form-group">
            <label for="income-gross">Annual Gross Income</label>
            <input type="number" id="income-gross" placeholder="100000" min="0" step="1000">
        </div>
        <div class="form-group">
            <label for="income-frequency">Pay Frequency</label>
            <select id="income-frequency">
                <option value="weekly">Weekly (52/year)</option>
                <option value="biweekly" selected>Bi-weekly (26/year)</option>
                <option value="semimonthly">Semi-monthly (24/year)</option>
                <option value="monthly">Monthly (12/year)</option>
            </select>
        </div>
        <div class="form-group">
            <label for="income-state">State</label>
            <select id="income-state">
                ${stateOptions}
            </select>
        </div>
    `,
    async () => {
      const data = {
        name: document.getElementById('income-name').value,
        income_type: document.getElementById('income-type').value,
        gross_annual: parseFloat(document.getElementById('income-gross').value) || 0,
        pay_frequency: document.getElementById('income-frequency').value,
        state: document.getElementById('income-state').value,
      };

      await apiCall('/api/budget/income', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      closeBudgetModal();
      loadIncomeSources();
      updatePaycheckPreview();
      showToast('Income source added', 'success');
    }
  );
}

function showAddExpenseModal() {
  const modal = createModal(
    'Add Expense',
    `
        <div class="form-group">
            <label for="expense-name">Name</label>
            <input type="text" id="expense-name" placeholder="e.g., Mortgage">
        </div>
        <div class="form-group">
            <label for="expense-category">Category</label>
            <select id="expense-category">
                <option value="1">Housing</option>
                <option value="2">Utilities</option>
                <option value="3">Transportation</option>
                <option value="4">Insurance</option>
                <option value="5">Healthcare</option>
                <option value="6">Debt Payments</option>
                <option value="7">Food & Dining</option>
                <option value="8">Entertainment</option>
                <option value="9">Savings & Investments</option>
                <option value="10">Personal</option>
                <option value="11">Education</option>
                <option value="12">Other</option>
            </select>
        </div>
        <div class="form-group">
            <label for="expense-amount">Amount</label>
            <input type="number" id="expense-amount" placeholder="2000" min="0" step="10">
        </div>
        <div class="form-group">
            <label for="expense-frequency">Frequency</label>
            <select id="expense-frequency">
                <option value="monthly" selected>Monthly</option>
                <option value="biweekly">Bi-weekly</option>
                <option value="weekly">Weekly</option>
                <option value="annual">Annual</option>
            </select>
        </div>
    `,
    async () => {
      const data = {
        name: document.getElementById('expense-name').value,
        category_id: document.getElementById('expense-category').value,
        amount: parseFloat(document.getElementById('expense-amount').value) || 0,
        frequency: document.getElementById('expense-frequency').value,
      };

      await apiCall('/api/budget/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      closeBudgetModal();
      loadExpenses();
      showToast('Expense added', 'success');
    }
  );
}

function showAddDeductionModal() {
  // Build income source options from loaded data
  const incomeOptions = budgetIncomeSources.length > 0
    ? budgetIncomeSources.map(inc =>
        `<option value="${inc.id}">${escapeHtml(inc.name)} (${inc.pay_frequency})</option>`
      ).join('')
    : '';

  const modal = createModal(
    'Add Pre-tax Deduction',
    `
        <div class="form-group">
            <label for="deduction-income-source">Income Source</label>
            <select id="deduction-income-source">
                <option value="">Not linked (applies to all)</option>
                ${incomeOptions}
            </select>
            <small style="color: var(--text-secondary); font-size: 0.85em;">Link to a specific income for accurate annual calculations</small>
        </div>
        <div class="form-group">
            <label for="deduction-label">Label (optional)</label>
            <input type="text" id="deduction-label" placeholder="e.g., John's 401k, Jane's HSA">
            <small style="color: var(--text-secondary); font-size: 0.85em;">Helpful for tracking multiple people's deductions</small>
        </div>
        <div class="form-group">
            <label for="deduction-type">Deduction Type</label>
            <select id="deduction-type">
                <option value="401k">401(k) Contribution</option>
                <option value="hsa">HSA Contribution</option>
                <option value="fsa">FSA (Healthcare/Dependent Care)</option>
                <option value="dental">Dental Insurance</option>
                <option value="vision">Vision Insurance</option>
                <option value="other">Other Pre-tax</option>
            </select>
        </div>
        <div class="form-group">
            <label for="deduction-amount">Amount Per Pay Period</label>
            <input type="number" id="deduction-amount" placeholder="500" min="0" step="25">
        </div>
        <div class="form-group">
            <label for="deduction-match">Employer Match Per Period (optional)</label>
            <input type="number" id="deduction-match" placeholder="250" min="0" step="25">
        </div>
    `,
    async () => {
      const incomeSourceId = document.getElementById('deduction-income-source').value || null;
      const data = {
        income_source_id: incomeSourceId,
        label: document.getElementById('deduction-label').value || null,
        deduction_type: document.getElementById('deduction-type').value,
        amount_per_period: parseFloat(document.getElementById('deduction-amount').value) || 0,
        employer_match: parseFloat(document.getElementById('deduction-match').value) || 0,
      };

      await apiCall('/api/budget/deductions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      closeBudgetModal();
      loadDeductions();
      updatePaycheckPreview();
      showToast('Deduction added', 'success');
    }
  );
}

// Delete functions
async function deleteIncome(id) {
  if (confirm('Delete this income source?')) {
    await apiCall(`/api/budget/income/${id}`, { method: 'DELETE' });
    loadIncomeSources();
    updatePaycheckPreview();
  }
}

async function deleteExpense(id) {
  if (confirm('Delete this expense?')) {
    await apiCall(`/api/budget/expenses/${id}`, { method: 'DELETE' });
    loadExpenses();
  }
}

async function deleteDeduction(id) {
  if (confirm('Delete this deduction?')) {
    await apiCall(`/api/budget/deductions/${id}`, { method: 'DELETE' });
    loadDeductions();
    updatePaycheckPreview();
  }
}

// Edit functions - open pre-filled modals
function editIncome(id) {
  const income = budgetIncomeSources.find((i) => i.id === id);
  if (!income) {
    showToast('Income source not found', 'error');
    return;
  }

  const modal = createModal(
    'Edit Income Source',
    `
        <div class="form-group">
            <label for="income-name">Name</label>
            <input type="text" id="income-name" value="${escapeHtml(income.name || '')}">
        </div>
        <div class="form-group">
            <label for="income-type">Type</label>
            <select id="income-type">
                <option value="employment" ${
                  income.income_type === 'employment' ? 'selected' : ''
                }>Employment (W-2)</option>
                <option value="self_employment" ${
                  income.income_type === 'self_employment' ? 'selected' : ''
                }>Self-Employment (1099)</option>
                <option value="rental" ${income.income_type === 'rental' ? 'selected' : ''}>Rental Income</option>
                <option value="investment" ${
                  income.income_type === 'investment' ? 'selected' : ''
                }>Investment Income</option>
                <option value="other" ${income.income_type === 'other' ? 'selected' : ''}>Other</option>
            </select>
        </div>
        <div class="form-group">
            <label for="income-gross">Annual Gross Income</label>
            <input type="number" id="income-gross" value="${income.gross_annual || ''}" min="0" step="1000">
        </div>
        <div class="form-group">
            <label for="income-frequency">Pay Frequency</label>
            <select id="income-frequency">
                <option value="weekly" ${income.pay_frequency === 'weekly' ? 'selected' : ''}>Weekly (52/year)</option>
                <option value="biweekly" ${
                  income.pay_frequency === 'biweekly' ? 'selected' : ''
                }>Bi-weekly (26/year)</option>
                <option value="semimonthly" ${
                  income.pay_frequency === 'semimonthly' ? 'selected' : ''
                }>Semi-monthly (24/year)</option>
                <option value="monthly" ${
                  income.pay_frequency === 'monthly' ? 'selected' : ''
                }>Monthly (12/year)</option>
            </select>
        </div>
        <div class="form-group">
            <label for="income-state">State</label>
            <select id="income-state">
                <option value="CA" ${income.state === 'CA' ? 'selected' : ''}>California</option>
                <option value="NY" ${income.state === 'NY' ? 'selected' : ''}>New York</option>
                <option value="TX" ${income.state === 'TX' ? 'selected' : ''}>Texas</option>
                <option value="FL" ${income.state === 'FL' ? 'selected' : ''}>Florida</option>
                <option value="WA" ${income.state === 'WA' ? 'selected' : ''}>Washington</option>
            </select>
        </div>
    `,
    async () => {
      const data = {
        name: document.getElementById('income-name').value,
        income_type: document.getElementById('income-type').value,
        gross_annual: parseFloat(document.getElementById('income-gross').value) || 0,
        pay_frequency: document.getElementById('income-frequency').value,
        state: document.getElementById('income-state').value,
      };

      await apiCall(`/api/budget/income/${id}`, {
        method: 'PUT',
        body: data,
      });

      closeBudgetModal();
      loadIncomeSources();
      updatePaycheckPreview();
      showToast('Income source updated', 'success');
    }
  );
}

function editExpense(id) {
  const expense = budgetExpenses.find((e) => e.id === id);
  if (!expense) {
    showToast('Expense not found', 'error');
    return;
  }

  const modal = createModal(
    'Edit Expense',
    `
        <div class="form-group">
            <label for="expense-name">Name</label>
            <input type="text" id="expense-name" value="${escapeHtml(expense.name || '')}">
        </div>
        <div class="form-group">
            <label for="expense-category">Category</label>
            <select id="expense-category">
                <option value="1" ${expense.category_id === '1' ? 'selected' : ''}>Housing</option>
                <option value="2" ${expense.category_id === '2' ? 'selected' : ''}>Utilities</option>
                <option value="3" ${expense.category_id === '3' ? 'selected' : ''}>Transportation</option>
                <option value="4" ${expense.category_id === '4' ? 'selected' : ''}>Insurance</option>
                <option value="5" ${expense.category_id === '5' ? 'selected' : ''}>Healthcare</option>
                <option value="6" ${expense.category_id === '6' ? 'selected' : ''}>Debt Payments</option>
                <option value="7" ${expense.category_id === '7' ? 'selected' : ''}>Food & Dining</option>
                <option value="8" ${expense.category_id === '8' ? 'selected' : ''}>Entertainment</option>
                <option value="9" ${expense.category_id === '9' ? 'selected' : ''}>Savings & Investments</option>
                <option value="10" ${expense.category_id === '10' ? 'selected' : ''}>Personal</option>
                <option value="11" ${expense.category_id === '11' ? 'selected' : ''}>Education</option>
                <option value="12" ${expense.category_id === '12' ? 'selected' : ''}>Other</option>
            </select>
        </div>
        <div class="form-group">
            <label for="expense-amount">Monthly Amount</label>
            <input type="number" id="expense-amount" value="${expense.monthly_amount || ''}" min="0" step="10">
        </div>
        <div class="form-group">
            <label for="expense-frequency">Frequency</label>
            <select id="expense-frequency">
                <option value="monthly" ${expense.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                <option value="weekly" ${expense.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
                <option value="biweekly" ${expense.frequency === 'biweekly' ? 'selected' : ''}>Bi-weekly</option>
                <option value="quarterly" ${expense.frequency === 'quarterly' ? 'selected' : ''}>Quarterly</option>
                <option value="annual" ${expense.frequency === 'annual' ? 'selected' : ''}>Annual</option>
                <option value="one_time" ${expense.frequency === 'one_time' ? 'selected' : ''}>One-time</option>
            </select>
        </div>
    `,
    async () => {
      const data = {
        name: document.getElementById('expense-name').value,
        category_id: document.getElementById('expense-category').value,
        amount: parseFloat(document.getElementById('expense-amount').value) || 0,
        frequency: document.getElementById('expense-frequency').value,
      };

      await apiCall(`/api/budget/expenses/${id}`, {
        method: 'PUT',
        body: data,
      });

      closeBudgetModal();
      loadExpenses();
      showToast('Expense updated', 'success');
    }
  );
}

function editDeduction(id) {
  const deduction = budgetDeductions.find((d) => d.id === id);
  if (!deduction) {
    showToast('Deduction not found', 'error');
    return;
  }

  // Build income source options from loaded data
  const incomeOptions = budgetIncomeSources.map(inc => {
    const selected = deduction.income_source_id === inc.id ? 'selected' : '';
    return `<option value="${inc.id}" ${selected}>${escapeHtml(inc.name)} (${inc.pay_frequency})</option>`;
  }).join('');

  const modal = createModal(
    'Edit Pre-tax Deduction',
    `
        <div class="form-group">
            <label for="deduction-income-source">Income Source</label>
            <select id="deduction-income-source">
                <option value="" ${!deduction.income_source_id ? 'selected' : ''}>Not linked (applies to all)</option>
                ${incomeOptions}
            </select>
        </div>
        <div class="form-group">
            <label for="deduction-type">Type</label>
            <select id="deduction-type">
                <option value="401k" ${deduction.deduction_type === '401k' ? 'selected' : ''}>401(k)</option>
                <option value="hsa" ${deduction.deduction_type === 'hsa' ? 'selected' : ''}>HSA</option>
                <option value="fsa" ${deduction.deduction_type === 'fsa' ? 'selected' : ''}>FSA</option>
                <option value="dental" ${
                  deduction.deduction_type === 'dental' ? 'selected' : ''
                }>Dental Insurance</option>
                <option value="vision" ${
                  deduction.deduction_type === 'vision' ? 'selected' : ''
                }>Vision Insurance</option>
                <option value="other" ${deduction.deduction_type === 'other' ? 'selected' : ''}>Other Pre-tax</option>
            </select>
        </div>
        <div class="form-group">
            <label for="deduction-amount">Amount per Period</label>
            <input type="number" id="deduction-amount" value="${deduction.amount_per_period || ''}" min="0" step="10">
        </div>
        <div class="form-group">
            <label for="deduction-match">Employer Match (%)</label>
            <input type="number" id="deduction-match" value="${
              deduction.employer_match || 0
            }" min="0" max="100" step="0.5">
        </div>
    `,
    async () => {
      const incomeSourceId = document.getElementById('deduction-income-source').value || null;
      const data = {
        income_source_id: incomeSourceId,
        deduction_type: document.getElementById('deduction-type').value,
        amount_per_period: parseFloat(document.getElementById('deduction-amount').value) || 0,
        employer_match: parseFloat(document.getElementById('deduction-match').value) || 0,
      };

      await apiCall(`/api/budget/deductions/${id}`, {
        method: 'PUT',
        body: data,
      });

      closeBudgetModal();
      loadDeductions();
      updatePaycheckPreview();
      showToast('Deduction updated', 'success');
    }
  );
}

// Helper modal function for budget page (uses same structure as other app modals)
function createModal(title, content, onSave) {
  // Remove existing budget modal if any
  closeBudgetModal();

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'budget-modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
        <div class="modal-backdrop" onclick="closeBudgetModal()"></div>
        <div class="modal-content">
            <div class="modal-header">
                <h2>${title}</h2>
                <button class="modal-close" onclick="closeBudgetModal()">&times;</button>
            </div>
            <div class="modal-body">
                ${content}
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeBudgetModal()">Cancel</button>
                <button class="btn btn-primary" id="modal-save-btn">Save</button>
            </div>
        </div>
    `;

  document.body.appendChild(modal);

  // Add save handler
  document.getElementById('modal-save-btn').addEventListener('click', onSave);

  return modal;
}

function closeBudgetModal() {
  const modal = document.getElementById('budget-modal');
  if (modal) {
    modal.remove();
  }
}

// Format helpers for budget
function formatIncomeType(type) {
  const types = {
    employment: 'Employment',
    self_employment: 'Self-Employment',
    rental: 'Rental',
    investment: 'Investment',
    other: 'Other',
  };
  return types[type] || type;
}

function formatPayFrequency(freq) {
  const freqs = {
    weekly: 'Weekly',
    biweekly: 'Bi-weekly',
    semimonthly: 'Semi-monthly',
    monthly: 'Monthly',
  };
  return freqs[freq] || freq;
}

function formatExpenseFrequency(freq) {
  const freqs = {
    weekly: 'Weekly',
    biweekly: 'Bi-weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    annual: 'Annual',
    one_time: 'One-time',
  };
  return freqs[freq] || freq;
}

function formatDeductionType(type) {
  const types = {
    '401k': '401(k)',
    hsa: 'HSA',
    fsa: 'FSA',
    dental: 'Dental Insurance',
    vision: 'Vision Insurance',
    other: 'Other Pre-tax',
  };
  return types[type] || type;
}

// =========================================================================
// END BUDGET TAB FUNCTIONS
// =========================================================================

// Helper to escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =========================================================================
// AI COMMENTARY FUNCTIONS
// =========================================================================

let commentaryCache = {};
let activePopover = null;

/**
 * Static explanations for elements that don't need dynamic AI generation.
 * These are pre-written, educational explanations that apply universally.
 */
const STATIC_EXPLANATIONS = {
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
 * Clear the AI commentary cache - call this when switching databases/profiles
 */
function clearCommentaryCache() {
  commentaryCache = {};
  // Also remove any existing AI buttons so they can be re-initialized
  document.querySelectorAll('.ai-info-btn').forEach((btn) => btn.remove());
  // Close any open popovers
  closeAICommentary();
  console.debug('AI Commentary: Cache and buttons cleared');
}

/**
 * Parse basic markdown to HTML
 * Supports: **bold**, *italic*, bullet lists, numbered lists, line breaks
 */
function parseMarkdown(text) {
  if (!text) return '';

  // Escape HTML entities first
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (but not if already part of bold)
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_([^_]+?)_(?!_)/g, '<em>$1</em>');

  // Split into lines for list processing
  const lines = html.split('\n');
  let result = [];
  let inBulletList = false;
  let inNumberedList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Bullet list: - item or * item
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      if (!inBulletList) {
        if (inNumberedList) {
          result.push('</ol>');
          inNumberedList = false;
        }
        result.push('<ul>');
        inBulletList = true;
      }
      result.push(`<li>${bulletMatch[1]}</li>`);
      continue;
    }

    // Numbered list: 1. item
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      if (!inNumberedList) {
        if (inBulletList) {
          result.push('</ul>');
          inBulletList = false;
        }
        result.push('<ol>');
        inNumberedList = true;
      }
      result.push(`<li>${numberedMatch[1]}</li>`);
      continue;
    }

    // End lists if we hit a non-list line
    if (inBulletList) {
      result.push('</ul>');
      inBulletList = false;
    }
    if (inNumberedList) {
      result.push('</ol>');
      inNumberedList = false;
    }

    // Regular line - wrap in paragraph if not empty
    if (line) {
      result.push(`<p>${line}</p>`);
    }
  }

  // Close any open lists
  if (inBulletList) result.push('</ul>');
  if (inNumberedList) result.push('</ol>');

  return result.join('');
}

function createPopoverElement(elementId) {
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

async function showAICommentary(button) {
  const elementId = button.dataset.elementId;

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
    const eventSource = new EventSource(`/api/commentary/${elementId}/stream`);
    let fullText = '';
    let ageHours = 0;
    let isCached = false;

    // Get content area and prepare for streaming
    const body = popover.querySelector('.commentary-body');
    const loading = body.querySelector('.commentary-loading');

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        eventSource.close();
        renderCommentaryError(popover, data.error);
        return;
      }

      if (data.type === 'cached') {
        // Cached response - show immediately
        isCached = true;
        fullText = data.commentary;
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
        if (!fullText) {
          if (loading) loading.remove();
          const contentDiv = document.createElement('div');
          contentDiv.className = 'commentary-content streaming';
          body.appendChild(contentDiv);
        }

        fullText += data.text;

        // Update content with parsed markdown
        const contentDiv = body.querySelector('.commentary-content');
        if (contentDiv) {
          contentDiv.innerHTML = parseMarkdown(fullText);
        }
      }

      if (data.type === 'complete') {
        eventSource.close();
        ageHours = data.age_hours || 0;

        // Cache the result
        commentaryCache[elementId] = {
          commentary: fullText,
          age_hours: ageHours,
          is_cached: false,
          element_id: elementId,
        };

        // Remove streaming class and add footer
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

    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      eventSource.close();
      if (!fullText) {
        renderCommentaryError(popover, 'Connection error. Please try again.');
      }
    };
  } catch (error) {
    console.error('Failed to start streaming:', error);
    renderCommentaryError(popover, error.message);
  }
}

function closeAICommentary() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  // Also close any orphaned containers and popovers
  document.querySelectorAll('.ai-popover-container').forEach((c) => c.remove());
  document.querySelectorAll('.ai-commentary-popover').forEach((p) => p.remove());
}

function positionPopover(popover, button) {
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

function renderCommentaryContent(popover, data) {
  const body = popover.querySelector('.commentary-body');
  body.innerHTML = ''; // Clear loading

  let ageText = '';
  if (data.age_hours !== undefined) {
    if (data.age_hours < 1) {
      ageText = 'Generated just now';
    } else if (data.age_hours < 24) {
      ageText = `Generated ${Math.round(data.age_hours)} hours ago`;
    } else {
      ageText = `Generated ${Math.round(data.age_hours / 24)} days ago`;
    }
  }

  // Content div - render markdown as HTML
  const contentDiv = document.createElement('div');
  contentDiv.className = 'commentary-content';
  contentDiv.innerHTML = parseMarkdown(data.commentary) || '<p>No commentary available.</p>';
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

function renderCommentaryError(popover, message) {
  const body = popover.querySelector('.commentary-body');
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

async function refreshCommentary(elementId) {
  // Clear from cache
  delete commentaryCache[elementId];

  // Find the button and re-trigger
  const button = document.querySelector(`[data-element-id="${elementId}"]`);
  if (button) {
    // Close current popover
    closeAICommentary();

    // Re-fetch with force refresh
    try {
      const response = await fetch(`/api/commentary/${elementId}?force_refresh=true`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      commentaryCache[elementId] = data;

      // Re-show the popover
      showAICommentary(button);
    } catch (error) {
      console.error('Failed to refresh commentary:', error);
      showToast('Failed to refresh insight', 'error');
    }
  }
}

async function refreshAllAIInsights() {
  try {
    showToast('Refreshing AI insights...', 'info');
    const response = await fetch('/api/commentary/refresh', { method: 'POST' });
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

function createInfoButton(elementId) {
  const btn = document.createElement('button');
  btn.className = 'ai-info-btn';
  btn.dataset.elementId = elementId;
  btn.title = 'Get AI insight';
  btn.textContent = '?';
  btn.onclick = function (e) {
    e.stopPropagation();
    showAICommentary(this);
  };

  return btn;
}

// Track if event listeners have been initialized
let commentaryListenersInitialized = false;

function initAICommentaryButtons() {
  // Map value element IDs to commentary element IDs
  const elementMappings = {
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
      if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.ai-info-btn')) {
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

// =========================================================================
// END AI COMMENTARY FUNCTIONS
// =========================================================================

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await initSession(); // Initialize session for multi-user mode (must be first)
  initTheme();
  initSidebarState(); // Initialize sidebar collapsed state
  initMobileNav(); // Initialize mobile navigation
  initStorageMode(); // Initialize storage mode preference
  initConfigPanels(); // Initialize collapsible config panels
  await loadProfiles(); // Load profiles for multi-database support
  await loadViews(); // Load views first to set up view selector
  await updatePriceStatus(); // Show price freshness status
  await checkDemoModeStatus(); // Check demo mode status

  // Show welcome page on first visit, otherwise go to dashboard
  if (isFirstVisit()) {
    showTab('welcome');
  } else {
    await refreshData();
  }
  initAICommentaryButtons(); // Add AI commentary info icons AFTER data loads
});
