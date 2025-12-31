// Investment Portfolio Dashboard JavaScript

const API_BASE = '';
let currentPositions = [];
let currentSort = { field: 'value', direction: 'desc' };
let selectedAccounts = new Set();
let currentViewId = localStorage.getItem('portfolioViewId') || null;
let availableViews = [];

// Utility functions
function formatCurrency(value) {
    if (value === null || value === undefined) return '-';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

function formatPrice(value, ticker = null) {
    // SGOV and certain securities use 3 decimal places for pricing
    if (value === null || value === undefined) return '-';
    const decimals = (ticker && ticker.toUpperCase() === 'SGOV') ? 3 : 2;
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
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

// Loading overlay
function showLoading(message = 'Loading...') {
    const overlay = document.getElementById('loading-overlay');
    const textEl = overlay.querySelector('.loading-text');
    if (textEl) textEl.textContent = message;
    overlay.style.display = 'flex';
    // Force reflow for transition
    overlay.offsetHeight;
    overlay.classList.add('visible');
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('visible');
    // Wait for transition then hide
    setTimeout(() => {
        if (!overlay.classList.contains('visible')) {
            overlay.style.display = 'none';
        }
    }, 200);
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
    radioButtons.forEach(radio => {
        radio.checked = radio.value === theme;
    });

    if (save) {
        localStorage.setItem('theme', theme);
        // Also save to server
        fetch(`${API_BASE}/api/settings/theme`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: theme })
        }).catch(console.error);
    }

    // Update Plotly charts if they exist
    updateChartTheme(theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
}

function updateChartTheme(theme) {
    const isDark = theme === 'dark';
    const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
        xaxis: {
            gridcolor: isDark ? '#303030' : '#f0f0f0',
            zerolinecolor: isDark ? '#424242' : '#d9d9d9'
        },
        yaxis: {
            gridcolor: isDark ? '#303030' : '#f0f0f0',
            zerolinecolor: isDark ? '#424242' : '#d9d9d9'
        }
    };

    // Update all existing charts
    ['chart-allocation', 'chart-account-type', 'chart-history', 'chart-projection'].forEach(id => {
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
        const response = await fetch(`${API_BASE}/api/settings/demo-mode`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });

        if (response.ok) {
            const data = await response.json();
            showToast(data.message || 'Demo mode updated', 'success');

            // Confirm reload with user
            if (confirm('Demo mode has been ' + (enabled ? 'enabled' : 'disabled') + '. Reload page to apply changes?')) {
                window.location.reload();
            } else {
                // Revert toggle if user cancels
                const toggle = document.getElementById('demo-mode-toggle');
                if (toggle) {
                    toggle.checked = !enabled;
                }
            }
        } else {
            showToast('Failed to update demo mode', 'error');
        }
    } catch (error) {
        console.error('Error toggling demo mode:', error);
        showToast('Failed to update demo mode', 'error');
    }
}

// Tab navigation
function showTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.nav-item').forEach(nav => {
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

    // Update page title
    const titles = {
        'dashboard': 'Dashboard',
        'holdings': 'Holdings',
        'analysis': 'Analysis',
        'projections': 'Projections',
        'settings': 'Settings'
    };
    document.getElementById('page-title').textContent = titles[tabName] || tabName;

    // Load tab-specific data
    if (tabName === 'analysis') {
        loadAnalysisData();
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
        views.forEach(view => {
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
    const view = availableViews.find(v => v.id === viewId);
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
        const activeProfile = profiles.find(p => p.is_active);
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

    profiles.forEach(profile => {
        const item = document.createElement('div');
        item.className = 'profile-item' + (profile.is_active ? ' active' : '');
        item.onclick = function() { switchProfile(profile.id); };

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
            setTimeout(function() {
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
            method: 'POST'
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
    setTimeout(function() {
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
        users: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
        briefcase: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>',
        building: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><line x1="9" y1="6" x2="9" y2="6.01"></line><line x1="15" y1="6" x2="15" y2="6.01"></line><line x1="9" y1="10" x2="9" y2="10.01"></line><line x1="15" y1="10" x2="15" y2="10.01"></line><line x1="9" y1="14" x2="9" y2="14.01"></line><line x1="15" y1="14" x2="15" y2="14.01"></line><line x1="9" y1="18" x2="15" y2="18"></line></svg>',
        star: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
        shield: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>'
    };

    container.innerHTML = profiles.map(function(profile) {
        const iconSvg = iconSvgs[profile.icon] || iconSvgs.user;
        const isActive = profile.is_active;
        const activeBadge = isActive ? '<span class="badge badge-success">Active</span>' : '';
        const lastAccessed = profile.last_accessed ? new Date(profile.last_accessed).toLocaleDateString() : 'Never';

        return '<div class="profile-management-card' + (isActive ? ' active' : '') + '">' +
            '<div class="profile-card-icon" style="background-color: ' + escapeHtml(profile.color) + '">' +
                iconSvg +
            '</div>' +
            '<div class="profile-card-info">' +
                '<div class="profile-card-name">' + escapeHtml(profile.name) + ' ' + activeBadge + '</div>' +
                '<div class="profile-card-description">' + escapeHtml(profile.description || 'No description') + '</div>' +
                '<div class="profile-card-stats">Last accessed: ' + lastAccessed + '</div>' +
            '</div>' +
            '<div class="profile-card-actions">' +
                (!isActive ? '<button class="btn btn-sm btn-primary" onclick="activateProfile(\'' + profile.id + '\')" title="Activate">Activate</button>' : '') +
                '<button class="btn btn-sm btn-default" onclick="editProfile(\'' + profile.id + '\')" title="Edit">Edit</button>' +
                '<button class="btn btn-sm btn-default" onclick="exportProfile(\'' + profile.id + '\')" title="Export">Export</button>' +
                '<button class="btn btn-sm btn-default" onclick="duplicateProfile(\'' + profile.id + '\')" title="Duplicate">Duplicate</button>' +
                (!isActive && profiles.length > 1 ? '<button class="btn btn-sm btn-danger" onclick="deleteProfile(\'' + profile.id + '\')" title="Delete">Delete</button>' : '') +
            '</div>' +
        '</div>';
    }).join('');
}

function showCreateProfileModal() {
    document.getElementById('profile-modal-title').textContent = 'Create Profile';
    document.getElementById('profile-id').value = '';
    document.getElementById('profile-name').value = '';
    document.getElementById('profile-description').value = '';

    // Reset color and icon to defaults
    const colorRadios = document.querySelectorAll('input[name="profile-color"]');
    colorRadios.forEach(function(r, i) { r.checked = i === 0; });

    const iconRadios = document.querySelectorAll('input[name="profile-icon"]');
    iconRadios.forEach(function(r, i) { r.checked = i === 0; });

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
        colorRadios.forEach(function(r) { r.checked = r.value === profile.color; });

        // Set icon
        const iconRadios = document.querySelectorAll('input[name="profile-icon"]');
        iconRadios.forEach(function(r) { r.checked = r.value === profile.icon; });

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
                body: JSON.stringify({ name: name, description: description, color: color, icon: icon })
            });
        } else {
            // Create new profile
            response = await fetch(API_BASE + '/api/profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, description: description, color: color, icon: icon })
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
            method: 'POST'
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
    if (!confirm('Are you sure you want to delete this profile? This will permanently delete all data in this profile and cannot be undone.')) {
        return;
    }

    try {
        const response = await fetch(API_BASE + '/api/profiles/' + profileId, {
            method: 'DELETE'
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
            body: JSON.stringify({ new_name: newName })
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
            body: formData
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
        container.innerHTML = '<div class="plugins-empty">' +
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
        importer: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
        analysis: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
        widget: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
        provider: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
        export: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>'
    };

    container.innerHTML = plugins.map(function(plugin) {
        var cardClasses = 'plugin-card';
        if (plugin.enabled) cardClasses += ' enabled';
        if (plugin.load_error) cardClasses += ' has-error';

        var icon = typeIcons[plugin.plugin_type] || typeIcons.widget;

        return '<div class="' + cardClasses + '">' +
            '<div class="plugin-icon ' + plugin.plugin_type + '">' + icon + '</div>' +
            '<div class="plugin-info">' +
                '<div class="plugin-header">' +
                    '<span class="plugin-name">' + escapeHtml(plugin.name) + '</span>' +
                    '<span class="plugin-version">v' + escapeHtml(plugin.version) + '</span>' +
                    '<span class="plugin-type-badge">' + plugin.plugin_type + '</span>' +
                    (plugin.is_builtin ? '<span class="badge badge-default">Built-in</span>' : '') +
                '</div>' +
                '<div class="plugin-description">' + escapeHtml(plugin.description || 'No description') + '</div>' +
                '<div class="plugin-meta">By ' + escapeHtml(plugin.author) + ' | ' + escapeHtml(plugin.license) + '</div>' +
                (plugin.load_error ? '<div class="plugin-error">Error: ' + escapeHtml(plugin.load_error) + '</div>' : '') +
            '</div>' +
            '<div class="plugin-actions">' +
                (plugin.enabled ?
                    '<button class="btn btn-sm btn-default" onclick="togglePlugin(\'' + plugin.plugin_id + '\', false)">Disable</button>' :
                    '<button class="btn btn-sm btn-primary" onclick="togglePlugin(\'' + plugin.plugin_id + '\', true)"' + (plugin.load_error ? ' disabled' : '') + '>Enable</button>'
                ) +
                (plugin.settings_schema && plugin.settings_schema.length > 0 ?
                    '<button class="btn btn-sm btn-default" onclick="showPluginSettings(\'' + plugin.plugin_id + '\')">Settings</button>' : ''
                ) +
            '</div>' +
        '</div>';
    }).join('');
}

async function togglePlugin(pluginId, enable) {
    try {
        const response = await fetch(API_BASE + '/api/plugins/' + pluginId + '/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enable: enable })
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

        data.schema.forEach(function(setting) {
            content += '<div class="form-group">';
            content += '<label for="plugin-' + setting.key + '">' + escapeHtml(setting.label) + '</label>';

            var value = data.settings[setting.key];
            if (value === undefined) value = setting.default;

            if (setting.type === 'select') {
                content += '<select id="plugin-' + setting.key + '" name="' + setting.key + '">';
                setting.options.forEach(function(opt) {
                    content += '<option value="' + escapeHtml(opt) + '"' + (value === opt ? ' selected' : '') + '>' + escapeHtml(opt) + '</option>';
                });
                content += '</select>';
            } else if (setting.type === 'boolean') {
                content += '<label class="toggle-switch">';
                content += '<input type="checkbox" id="plugin-' + setting.key + '" name="' + setting.key + '"' + (value ? ' checked' : '') + '>';
                content += '<span class="toggle-slider"></span>';
                content += '</label>';
            } else if (setting.type === 'number') {
                content += '<input type="number" id="plugin-' + setting.key + '" name="' + setting.key + '" value="' + (value || '') + '">';
            } else {
                content += '<input type="text" id="plugin-' + setting.key + '" name="' + setting.key + '" value="' + escapeHtml(value || '') + '">';
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

    var plugin = availablePlugins.find(function(p) { return p.plugin_id === pluginId; });
    if (plugin && plugin.settings_schema) {
        plugin.settings_schema.forEach(function(setting) {
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
            body: JSON.stringify({ settings: settings })
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
        data.plugins.forEach(function(plugin) {
            html += '<div class="plugin-result">';
            html += '<h4>' + escapeHtml(plugin.plugin_name) + '</h4>';

            // Show key metrics
            if (plugin.metrics) {
                html += '<div class="plugin-metrics">';

                // Tax-Loss Harvester metrics
                if (plugin.metrics.total_unrealized_losses !== undefined) {
                    html += '<div class="metric-item">';
                    html += '<span class="metric-value negative">$' + formatNumber(plugin.metrics.total_unrealized_losses) + '</span>';
                    html += '<span class="metric-label">Unrealized Losses</span>';
                    html += '</div>';
                    html += '<div class="metric-item">';
                    html += '<span class="metric-value positive">$' + formatNumber(plugin.metrics.estimated_tax_savings) + '</span>';
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
                    html += '<span class="metric-value positive">$' + formatNumber(plugin.metrics.estimated_annual_income) + '</span>';
                    html += '<span class="metric-label">Est. Annual Dividends</span>';
                    html += '</div>';
                    html += '<div class="metric-item">';
                    html += '<span class="metric-value">' + plugin.metrics.portfolio_yield.toFixed(2) + '%</span>';
                    html += '<span class="metric-label">Portfolio Yield</span>';
                    html += '</div>';
                    html += '<div class="metric-item">';
                    html += '<span class="metric-value">$' + formatNumber(plugin.metrics.monthly_income_estimate || 0) + '</span>';
                    html += '<span class="metric-label">Monthly Income</span>';
                    html += '</div>';
                }

                html += '</div>';
            }

            // Show insights
            if (plugin.insights && plugin.insights.length > 0) {
                html += '<div class="plugin-insights-list">';
                plugin.insights.forEach(function(insight) {
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
        data.widgets.forEach(function(widget) {
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

        permData.plugins.forEach(function(plugin) {
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
                actions = '<button class="btn btn-xs btn-danger" onclick="revokePluginPermissions(\'' + plugin.plugin_id + '\')">Revoke</button>';
            } else if (plugin.needs_approval) {
                status = '<span class="badge badge-warning">Pending</span>';
                actions = '<button class="btn btn-xs btn-primary" onclick="approvePluginPermissions(\'' + plugin.plugin_id + '\', true)">Approve</button> ';
                actions += '<button class="btn btn-xs btn-danger" onclick="approvePluginPermissions(\'' + plugin.plugin_id + '\', false)">Deny</button>';
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
            html = '<div class="alert alert-warning" style="margin-bottom: 15px;">' +
                   '<strong>' + permData.pending_count + ' plugin(s)</strong> require permission approval before they can be loaded.' +
                   '</div>' + html;
        }

        container.innerHTML = html;

        // Render audit log
        if (auditData.entries && auditData.entries.length > 0) {
            var auditHtml = '<div class="audit-log">';
            auditData.entries.slice(0, 10).forEach(function(entry) {
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
            body: JSON.stringify({ approve: approve })
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
            method: 'POST'
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
                ${data.plugins.map(plugin => `
                    <div class="installed-plugin-card" data-plugin-id="${escapeHtml(plugin.plugin_id)}">
                        <div class="plugin-info">
                            <div class="plugin-header">
                                <span class="plugin-name">${escapeHtml(plugin.name)}</span>
                                <span class="plugin-version">v${escapeHtml(plugin.version)}</span>
                                <span class="plugin-type badge badge-${getPluginTypeBadgeClass(plugin.plugin_type)}">${escapeHtml(plugin.plugin_type)}</span>
                            </div>
                            <p class="plugin-description">${escapeHtml(plugin.description || 'No description')}</p>
                            <div class="plugin-meta">
                                <span class="plugin-author">By ${escapeHtml(plugin.author || 'Unknown')}</span>
                                ${plugin.source ? `
                                    <span class="plugin-source">
                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                            ${plugin.source.type === 'git' ? '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>' : '<rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M12 12l-4-4-4 4"></path>'}
                                        </svg>
                                        ${escapeHtml(plugin.source.url || plugin.source.type)}
                                    </span>
                                ` : ''}
                            </div>
                        </div>
                        <div class="plugin-actions">
                            ${plugin.source && plugin.source.type === 'git' ? `
                                <button class="btn btn-sm btn-default" onclick="checkPluginUpdate('${escapeHtml(plugin.plugin_id)}')" title="Check for updates">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="23 4 23 10 17 10"></polyline>
                                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                                    </svg>
                                </button>
                            ` : ''}
                            <button class="btn btn-sm btn-danger" onclick="uninstallPlugin('${escapeHtml(plugin.plugin_id)}')" title="Uninstall plugin">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

    } catch (error) {
        console.error('Error loading installed plugins:', error);
        container.innerHTML = '<p class="text-muted">Failed to load installed plugins. ' + escapeHtml(error.message) + '</p>';
    }
}

function getPluginTypeBadgeClass(pluginType) {
    const classes = {
        'importer': 'info',
        'analysis': 'success',
        'widget': 'warning',
        'provider': 'primary',
        'export': 'secondary'
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
    document.querySelectorAll('.install-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab content
    document.querySelectorAll('.install-tab-content').forEach(content => {
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
        const response = await fetch(API_BASE + '/api/plugins/install/git', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: source })
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

        const response = await fetch(API_BASE + '/api/plugins/install/upload', {
            method: 'POST',
            body: formData
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
        const response = await fetch(API_BASE + '/api/plugins/installed/' + pluginId, {
            method: 'DELETE'
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
            if (confirm(`Update available: ${data.current_commit} → ${data.latest_commit}\n\nWould you like to update now?`)) {
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
        const response = await fetch(API_BASE + '/api/plugins/installed/' + pluginId + '/update', {
            method: 'POST'
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

        const response = await fetch(API_BASE + '/api/plugins/installed/check-updates', {
            method: 'POST'
        });

        if (!response.ok) throw new Error('Failed to check for updates');

        const data = await response.json();

        if (data.count > 0) {
            banner.style.display = 'flex';
            countEl.textContent = `${data.count} Update${data.count > 1 ? 's' : ''} Available`;
            messageEl.textContent = data.updates_available.map(u => u.plugin_id).join(', ');
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

    } catch (error) {
        console.error('Error loading data:', error);
        showToast('Failed to load portfolio data', 'error');
    } finally {
        hideLoading();
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
        const url = force
            ? `${API_BASE}/api/imports/refresh-prices?force=true`
            : `${API_BASE}/api/imports/refresh-prices`;
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
            const hoursAgo = newestUpdate
                ? Math.round((Date.now() - newestUpdate.getTime()) / (1000 * 60 * 60))
                : null;

            statusEl.className = 'price-status fresh';
            statusEl.innerHTML = `<span class="status-dot"></span> Prices fresh${hoursAgo !== null ? ` (${hoursAgo}h ago)` : ''}`;
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
            messageEl.textContent = `Found ${count} position${count > 1 ? 's' : ''} with identical tickers and quantities across different accounts. This may indicate duplicate entries.`;
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
            ${duplicatesData.map(dup => `
                <div class="duplicate-item">
                    <h4>${dup.ticker} - ${dup.shares.toFixed(6)} shares</h4>
                    <p>${dup.reason}</p>
                    <div class="positions">
                        ${dup.positions.map(pos => `
                            <div class="position-chip">
                                <span class="account">${pos.account_name}</span>
                                <span>${formatCurrency(pos.value)}</span>
                                <span class="delete-btn" onclick="deleteDuplicatePosition('${pos.id}')" title="Delete this position">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                    </svg>
                                </span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('')}
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
            method: 'DELETE'
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

    tbody.innerHTML = sortedAccounts.map(acc => {
        const pct = total > 0 ? (acc.value / total * 100) : 0;
        const typeClass = acc.is_retirement ? 'type-retirement' : 'type-taxable';

        return `
            <tr>
                <td><strong>${acc.name}</strong></td>
                <td><span class="account-type-badge ${typeClass}">${acc.display_type}</span></td>
                <td class="text-right">${formatCurrency(acc.value)}</td>
                <td class="text-right">${pct.toFixed(1)}%</td>
            </tr>
        `;
    }).join('');

    if (sumEl) {
        sumEl.textContent = formatCurrency(total);
    }
}

function updateAccountFilter(positions) {
    const accounts = [...new Set(positions.map(p => p.account))].sort();
    const optionsContainer = document.getElementById('account-filter-options');

    // Preserve current selection
    const currentSelection = new Set(selectedAccounts);

    optionsContainer.innerHTML = accounts.map(acc => `
        <div class="multi-select-option">
            <input type="checkbox" id="acc-${acc.replace(/\s+/g, '-')}" value="${acc}"
                   ${currentSelection.size === 0 || currentSelection.has(acc) ? 'checked' : ''}
                   onchange="handleAccountFilterChange()">
            <label for="acc-${acc.replace(/\s+/g, '-')}">${acc}</label>
        </div>
    `).join('');

    // Initialize selectedAccounts if empty (select all by default)
    if (selectedAccounts.size === 0) {
        selectedAccounts = new Set(accounts);
    }

    updateAccountFilterLabel();
}

function handleAccountFilterChange() {
    const checkboxes = document.querySelectorAll('#account-filter-options input[type="checkbox"]');
    selectedAccounts = new Set();
    checkboxes.forEach(cb => {
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
    document.querySelectorAll('.multi-select-dropdown.open').forEach(d => {
        d.classList.remove('open');
    });

    // Toggle this one
    if (!wasOpen) {
        dropdown.classList.add('open');
    }
}

function selectAllAccounts(selectAll) {
    const checkboxes = document.querySelectorAll('#account-filter-options input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = selectAll;
    });
    handleAccountFilterChange();
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select-dropdown')) {
        document.querySelectorAll('.multi-select-dropdown.open').forEach(d => {
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

    filtered.forEach(pos => {
        const gainLoss = pos.cost_basis ? (pos.value - pos.cost_basis) : null;
        const gainLossPct = pos.cost_basis ? ((pos.value - pos.cost_basis) / pos.cost_basis * 100) : null;

        // Format value with APY indicator for interest-bearing positions
        let valueDisplay = formatCurrency(pos.value);
        if (pos.interest_rate && pos.interest_rate > 0) {
            const apyPct = (pos.interest_rate * 100).toFixed(2);
            valueDisplay = `<span title="Includes accrued interest at ${apyPct}% APY">${formatCurrency(pos.value)} 📈</span>`;
        }

        const row = document.createElement('tr');
        row.dataset.account = pos.account;
        row.innerHTML = `
            <td><strong>${pos.ticker}</strong></td>
            <td>${pos.name || '-'}</td>
            <td>${pos.account}</td>
            <td class="text-right">${formatShares(pos.shares)}</td>
            <td class="text-right">${pos.price ? formatPrice(pos.price, pos.ticker) : '<span class="text-warning">$0.00</span>'}</td>
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
                        <button onclick="showEditPositionModal('${pos.id}', '${pos.ticker}', ${pos.shares}, ${pos.price || 0}, ${pos.cost_basis || 0}, '${pos.position_type || 'equity'}', ${pos.interest_rate || 'null'}, '${pos.purchase_date || ''}', '${pos.maturity_date || ''}')">
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
                aVal = a.cost_basis ? (a.value - a.cost_basis) : -Infinity;
                bVal = b.cost_basis ? (b.value - b.cost_basis) : -Infinity;
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
    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === currentSort.field) {
            th.classList.add(`sort-${currentSort.direction}`);
        }
    });
}

function filterPositionsList(positions) {
    const search = document.getElementById('holdings-search').value.toLowerCase();

    return positions.filter(pos => {
        // Search filter
        const searchMatch = !search ||
            pos.ticker.toLowerCase().includes(search) ||
            (pos.name && pos.name.toLowerCase().includes(search)) ||
            pos.account.toLowerCase().includes(search);

        // Account filter using the selectedAccounts Set (if empty, show all)
        const accountMatch = selectedAccounts.size === 0 ||
            selectedAccounts.has(pos.account);

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
            method: 'DELETE'
        });
        showToast('Position deleted', 'success');
        refreshData();
    } catch (error) {
        showToast('Failed to delete position', 'error');
    }
}

// Edit Position Modal
function showEditPositionModal(id, ticker, shares, price, costBasis, positionType, interestRate, purchaseDate, maturityDate) {
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
            body: JSON.stringify(data)
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
    displayModeBar: false,  // Hide the modebar entirely
    staticPlot: false       // Still allow hover interactions
};

function updateAllocationCharts(positions, summary) {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const chartLayout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
        margin: { t: 10, b: 10, l: 10, r: 10 },
        showlegend: false  // Hidden - percentages shown on chart, hover for details
    };

    // Account type allocation
    const accountAlloc = {};
    positions.forEach(pos => {
        const type = pos.account_type || 'unknown';
        accountAlloc[type] = (accountAlloc[type] || 0) + (pos.value || 0);
    });

    const accountLabels = Object.keys(accountAlloc).map(k =>
        k.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())
    );
    const accountValues = Object.values(accountAlloc);

    Plotly.newPlot('chart-account-type', [{
        type: 'pie',
        labels: accountLabels,
        values: accountValues,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'inside',
        insidetextorientation: 'horizontal',
        hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>',
        marker: {
            colors: ['#1668dc', '#49aa19', '#9254de', '#d87a16', '#13a8a8', '#dc4446']
        }
    }], chartLayout, plotlyConfig);

    // Ticker allocation (top 10)
    const tickerAlloc = {};
    positions.forEach(pos => {
        tickerAlloc[pos.ticker] = (tickerAlloc[pos.ticker] || 0) + (pos.value || 0);
    });

    const sortedTickers = Object.entries(tickerAlloc)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    const otherValue = Object.values(tickerAlloc).reduce((a, b) => a + b, 0) -
        sortedTickers.reduce((a, b) => a + b[1], 0);

    const allocLabels = sortedTickers.map(t => t[0]);
    const allocValues = sortedTickers.map(t => t[1]);

    if (otherValue > 0) {
        allocLabels.push('Other');
        allocValues.push(otherValue);
    }

    Plotly.newPlot('chart-allocation', [{
        type: 'pie',
        labels: allocLabels,
        values: allocValues,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'inside',
        insidetextorientation: 'horizontal',
        hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>'
    }], chartLayout, plotlyConfig);
}

function updateHistoryChart(history) {
    const container = document.getElementById('chart-history');

    if (!history || history.length === 0) {
        container.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">No history data yet</p>';
        return;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const dates = history.map(h => h.date);
    const totals = history.map(h => h.total);
    const retirement = history.map(h => h.retirement);
    const taxable = history.map(h => h.taxable);

    Plotly.newPlot('chart-history', [
        {
            x: dates,
            y: totals,
            type: 'scatter',
            mode: 'lines',
            name: 'Total',
            line: { color: '#1668dc', width: 2 }
        },
        {
            x: dates,
            y: retirement,
            type: 'scatter',
            mode: 'lines',
            name: 'Retirement',
            line: { color: '#49aa19', width: 1 }
        },
        {
            x: dates,
            y: taxable,
            type: 'scatter',
            mode: 'lines',
            name: 'Taxable',
            line: { color: '#d87a16', width: 1 }
        }
    ], {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
        margin: { t: 20, b: 40, l: 70, r: 20 },
        xaxis: {
            gridcolor: isDark ? '#303030' : '#f0f0f0'
        },
        yaxis: {
            title: '',
            tickformat: '$,.0f',
            gridcolor: isDark ? '#303030' : '#f0f0f0'
        },
        legend: { orientation: 'h', y: 1.1 },
        hovermode: 'x unified'
    }, plotlyConfig);
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
            fetch(`${API_BASE}/api/analysis/triggers/triggered`)
        ]);

        const [perf, risk, alloc, detailed, triggered] = await Promise.all([
            perfResp.json(),
            riskResp.json(),
            allocResp.json(),
            detailedResp.json(),
            triggeredResp.json()
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

    } catch (error) {
        console.error('Error loading analysis data:', error);
    } finally {
        hideLoading();
    }
}

function showAllocationTab(tab) {
    currentAllocationTab = tab;

    // Update tab buttons
    document.querySelectorAll('.alloc-tab').forEach(btn => {
        btn.classList.remove('active');
        const btnText = btn.textContent.toLowerCase().replace(/ /g, '-');
        if (btnText === tab ||
            (btn.textContent === 'Asset Class' && tab === 'asset-class') ||
            (btn.textContent === 'Position Type' && tab === 'position-type') ||
            (btn.textContent === 'Market Cap' && tab === 'cap')) {
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
        tbody.innerHTML = '<tr><td colspan="3" class="text-muted">No data available. Ensure funds are defined in funds.yaml with allocation percentages.</td></tr>';
        return;
    }

    rows.forEach(row => {
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
    currentPositions.forEach(pos => {
        const ticker = pos.ticker;
        tickerValues[ticker] = (tickerValues[ticker] || 0) + (pos.value || 0);
    });

    const sorted = Object.entries(tickerValues)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    const totalValue = Object.values(tickerValues).reduce((a, b) => a + b, 0);

    container.innerHTML = sorted.map(([ticker, value]) => {
        const pct = totalValue > 0 ? (value / totalValue * 100) : 0;
        return `
            <div class="holding-item">
                <span class="holding-ticker">${ticker}</span>
                <span class="holding-value">${formatCurrency(value)} <span class="holding-pct">(${pct.toFixed(1)}%)</span></span>
            </div>
        `;
    }).join('');
}

function renderTriggeredAlerts(triggered) {
    const container = document.getElementById('alerts-list');

    if (!triggered || triggered.length === 0) {
        container.innerHTML = '<p class="text-muted">No alerts triggered. Add alerts to monitor your portfolio conditions.</p>';
        return;
    }

    container.innerHTML = triggered.map(alert => `
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
    `).join('');
}

// Metric Detail Modal Functions
// Note: Data displayed is from user's local portfolio - this is a local-only application
const metricExplanations = {
    'ytd-return': {
        title: 'Year-to-Date Return',
        explanation: '<strong>YTD Return</strong> measures how much your portfolio has grown since January 1st of this year. ' +
            'It is calculated as the weighted average of each position\'s YTD performance based on current portfolio weights. ' +
            'A positive value means your portfolio has gained value this year, while negative means a decline.'
    },
    'one-year-return': {
        title: '1-Year Return',
        explanation: '<strong>1-Year Return</strong> (also called trailing twelve months or TTM) shows your portfolio\'s ' +
            'performance over the past 12 months. This is a rolling period that updates daily, providing a longer-term view ' +
            'of performance compared to YTD.'
    },
    'alpha': {
        title: 'Alpha vs S&P 500',
        explanation: '<strong>Alpha</strong> measures how much your portfolio has outperformed (positive) or underperformed ' +
            '(negative) compared to the S&P 500 benchmark. An alpha of +2% means you beat the market by 2 percentage points. ' +
            'This is a key measure of whether active management or stock picking is adding value.'
    },
    'volatility': {
        title: 'Volatility (Annual)',
        explanation: '<strong>Volatility</strong> measures the standard deviation of your portfolio\'s daily returns, ' +
            'annualized to show what you might expect over a year. Higher volatility means more dramatic price swings. ' +
            '<br><br>Typical ranges: Low-risk portfolio: 5-10%, Balanced: 10-15%, Aggressive: 15-25%+'
    },
    'sharpe': {
        title: 'Sharpe Ratio',
        explanation: '<strong>Sharpe Ratio</strong> measures risk-adjusted returns - how much return you\'re getting per unit ' +
            'of risk taken. It is calculated as (Portfolio Return - Risk-Free Rate) / Volatility. ' +
            '<br><br>Interpretation: &lt; 1.0 = Below average, 1.0-2.0 = Good, &gt; 2.0 = Excellent'
    },
    'max-drawdown': {
        title: 'Maximum Drawdown',
        explanation: '<strong>Max Drawdown</strong> shows the largest peak-to-trough decline in your portfolio\'s value ' +
            'over the past year. This represents the worst-case scenario an investor would have experienced. ' +
            '<br><br>For example, -20% means at some point the portfolio dropped 20% from its previous high.'
    },
    'beta': {
        title: 'Portfolio Beta',
        explanation: '<strong>Beta</strong> measures your portfolio\'s sensitivity to market movements. A beta of 1.0 ' +
            'means your portfolio moves in line with the market. ' +
            '<br><br>Beta &gt; 1.0: More volatile than market, amplifies gains/losses<br>' +
            'Beta &lt; 1.0: Less volatile, dampens market swings<br>' +
            'Beta = 0: No correlation to market'
    },
    'var': {
        title: 'Value at Risk (95%)',
        explanation: '<strong>VaR 95%</strong> estimates the maximum daily loss you could expect 95% of the time. ' +
            'In other words, losses exceeding this amount should only occur about 1 in 20 trading days. ' +
            '<br><br>For example, VaR of 2.5% on a $1M portfolio means daily losses should stay under $25,000 ' +
            'about 95% of the time.'
    }
};

function showMetricDetail(metricId) {
    const metric = metricExplanations[metricId];
    if (!metric) {
        showToast('Details not available for this metric', 'info');
        return;
    }

    const content = '<div class="metric-explanation">' + metric.explanation + '</div>' +
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
    currentPositions.forEach(pos => {
        const ticker = pos.ticker;
        if (!tickerData[ticker]) {
            tickerData[ticker] = {
                ticker: ticker,
                name: pos.name || ticker,
                shares: 0,
                value: 0,
                accounts: []
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
    const topPct = totalValue > 0 ? (topValue / totalValue * 100) : 0;

    // Build table rows - data is from user's local portfolio
    const tableRows = sorted.map((pos, idx) => {
        const pct = totalValue > 0 ? (pos.value / totalValue * 100) : 0;
        return '<tr>' +
            '<td>' + (idx + 1) + '</td>' +
            '<td><strong>' + escapeHtml(pos.ticker) + '</strong></td>' +
            '<td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">' + escapeHtml(pos.name) + '</td>' +
            '<td class="text-right">' + formatShares(pos.shares) + '</td>' +
            '<td class="text-right">' + formatCurrency(pos.value) + '</td>' +
            '<td class="text-right">' + pct.toFixed(2) + '%</td>' +
            '</tr>';
    }).join('');

    const content = '<div class="detail-summary">' +
        '<div class="detail-summary-item">' +
            '<div class="detail-summary-label">Top ' + count + ' Value</div>' +
            '<div class="detail-summary-value">' + formatCurrency(topValue) + '</div>' +
        '</div>' +
        '<div class="detail-summary-item">' +
            '<div class="detail-summary-label">% of Portfolio</div>' +
            '<div class="detail-summary-value">' + topPct.toFixed(1) + '%</div>' +
        '</div>' +
        '<div class="detail-summary-item">' +
            '<div class="detail-summary-label">Total Portfolio</div>' +
            '<div class="detail-summary-value">' + formatCurrency(totalValue) + '</div>' +
        '</div>' +
        '</div>' +
        '<table class="detail-table">' +
        '<thead><tr>' +
            '<th>#</th><th>Ticker</th><th>Name</th>' +
            '<th class="text-right">Shares</th><th class="text-right">Value</th><th class="text-right">% of Portfolio</th>' +
        '</tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '</table>';

    showModal('Top ' + count + ' Holdings', content);
}

function showCashDetail() {
    if (!currentPositions || currentPositions.length === 0) {
        showToast('No holdings data available', 'info');
        return;
    }

    // Find all cash-like positions
    const cashPositions = currentPositions.filter(pos => {
        const ticker = (pos.ticker || '').toUpperCase();
        const posType = (pos.position_type || '').toLowerCase();
        return ticker === 'CASH' ||
               ticker.includes('MONEY MARKET') ||
               ticker.includes('MMKT') ||
               posType === 'cash' ||
               posType === 'cd';
    });

    const totalValue = currentPositions.reduce((sum, p) => sum + (p.value || 0), 0);
    const cashValue = cashPositions.reduce((sum, p) => sum + (p.value || 0), 0);
    const cashPct = totalValue > 0 ? (cashValue / totalValue * 100) : 0;

    let content = '';

    if (cashPositions.length === 0) {
        content = '<div class="metric-explanation">' +
            '<strong>No cash positions found.</strong><br><br>' +
            'Cash positions include: Money market funds, bank sweep accounts, and CDs. ' +
            'Your portfolio appears to be fully invested in securities.' +
            '</div>';
    } else {
        const tableRows = cashPositions.map(pos =>
            '<tr>' +
            '<td>' + escapeHtml(pos.account_name || '-') + '</td>' +
            '<td>' + escapeHtml(pos.name || pos.ticker || 'Cash') + '</td>' +
            '<td class="text-right">' + formatCurrency(pos.value) + '</td>' +
            '</tr>'
        ).join('');

        content = '<div class="detail-summary">' +
            '<div class="detail-summary-item">' +
                '<div class="detail-summary-label">Total Cash</div>' +
                '<div class="detail-summary-value">' + formatCurrency(cashValue) + '</div>' +
            '</div>' +
            '<div class="detail-summary-item">' +
                '<div class="detail-summary-label">% of Portfolio</div>' +
                '<div class="detail-summary-value">' + cashPct.toFixed(1) + '%</div>' +
            '</div>' +
            '</div>' +
            '<table class="detail-table">' +
            '<thead><tr><th>Account</th><th>Type</th><th class="text-right">Value</th></tr></thead>' +
            '<tbody>' + tableRows + '</tbody>' +
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
        opSelect.innerHTML = data.operators
            .map(op => `<option value="${op}">${op}</option>`)
            .join('');

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
            body: JSON.stringify(data)
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
            method: 'DELETE'
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
            body: JSON.stringify({ ticker, use_claude: true })
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
    document.getElementById('fa-style').textContent = result.style ? result.style.charAt(0).toUpperCase() + result.style.slice(1) : '-';
    document.getElementById('fa-cap').textContent = result.market_cap ? result.market_cap.charAt(0).toUpperCase() + result.market_cap.slice(1) : '-';
    document.getElementById('fa-region').textContent = result.region ? result.region.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()) : '-';

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

        const sortedSectors = Object.entries(result.sector_breakdown)
            .sort((a, b) => b[1] - a[1]);

        sectorsList.innerHTML = sortedSectors.map(([sector, pct]) => `
            <div class="holding-item">
                <span class="holding-ticker">${sector}</span>
                <span class="holding-value">${pct.toFixed(1)}%</span>
            </div>
        `).join('');
    } else {
        sectorsContainer.style.display = 'none';
    }
}

async function analyzePortfolioFunds() {
    showLoading('Analyzing portfolio funds...');

    try {
        const resp = await fetch(`${API_BASE}/api/analysis/fund/analyze-portfolio`, {
            method: 'POST'
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
                risk_tolerance: null
            })
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
    document.getElementById('advisor-portfolio-fit').textContent = result.portfolio_fit || 'No portfolio fit analysis available.';
    document.getElementById('advisor-tax').textContent = result.tax_considerations || 'No tax considerations available.';
    document.getElementById('advisor-risk').textContent = result.risk_notes || 'No risk notes available.';

    // Show overlaps if present
    const overlapsSection = document.getElementById('advisor-overlaps-section');
    const overlapsContainer = document.getElementById('advisor-overlaps');
    if (result.overlaps && result.overlaps.length > 0) {
        overlapsSection.style.display = 'block';
        overlapsContainer.innerHTML = result.overlaps.map(o => `
            <div class="overlap-item">
                <span class="overlap-ticker">${o.ticker || 'Unknown'}</span>
                ${o.overlap_pct ? `<span class="overlap-pct">${o.overlap_pct}% overlap</span>` : ''}
                <span class="overlap-desc">${o.description || ''}</span>
            </div>
        `).join('');
    } else {
        overlapsSection.style.display = 'none';
    }

    // Show recommendations if present
    const recsSection = document.getElementById('advisor-recommendations-section');
    const recsList = document.getElementById('advisor-recommendations');
    if (result.recommendations && result.recommendations.length > 0) {
        recsSection.style.display = 'block';
        recsList.innerHTML = result.recommendations.map(r => `<li>${r}</li>`).join('');
    } else {
        recsSection.style.display = 'none';
    }
}

function formatAdvisorText(text) {
    if (!text) return 'No commentary available.';
    // Convert line breaks to <br> and paragraphs
    return text.split('\n\n').map(p => `<p>${p}</p>`).join('');
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

// Generic streaming chat function that works with any container
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
                include_portfolio: true
            })
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
    await sendStreamingChatMessage('chat-messages', 'chat-input', currentAnalysisTicker);
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
    await sendStreamingChatMessage('global-chat-messages', 'global-chat-input', null);
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

        // Load API keys status, views, and accounts management
        await Promise.all([loadApiKeysStatus(), loadViewsList(), loadAccountsManagement()]);

    } catch (error) {
        console.error('Error loading settings:', error);
    }
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

        tbody.innerHTML = accounts.map(account => `
            <tr>
                <td>
                    <div class="account-info">
                        <span class="account-name">${account.name}</span>
                        <span class="account-meta">${account.display_type} · ${account.brokerage || 'N/A'} · ${account.position_count || 0} positions</span>
                    </div>
                </td>
                <td class="text-right">${formatCurrency(account.value || 0)}</td>
                <td class="text-right">
                    <button class="btn btn-sm btn-danger" onclick="deleteAccount('${account.id}', '${account.name.replace(/'/g, "\\'")}')">
                        Delete
                    </button>
                </td>
            </tr>
        `).join('');
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
            method: 'DELETE'
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
            await new Promise(resolve => setTimeout(resolve, 500));
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
            'alpha_vantage': 'Alpha Vantage',
            'massive': 'Massive',
            'finnhub': 'Finnhub',
            'anthropic_api_key': 'Anthropic (Claude)'
        };

        const keyDescriptions = {
            'alpha_vantage': 'Stock prices & fundamentals',
            'massive': 'Price data backup',
            'finnhub': 'Real-time stock prices',
            'anthropic_api_key': 'AI fund analysis'
        };

        container.innerHTML = Object.entries(data.api_keys).map(([key, status]) => `
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
                    <button class="btn btn-sm btn-default" onclick="showApiKeyEditor('${key}', '${keyNames[key] || key}')">
                        ${status.configured ? 'Edit' : 'Add'}
                    </button>
                </div>
            </div>
        `).join('');
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
            body: JSON.stringify({ key: keyId, value: value })
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
            method: 'DELETE'
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
            fetch(`${API_BASE}/api/portfolio/accounts`)
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

        container.innerHTML = views.map(view => {
            const accountNames = view.account_ids
                .map(id => accounts.find(a => a.id === id))
                .filter(a => a)
                .map(a => a.name)
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
                        ${view.name !== 'All Accounts' ? `
                            <button onclick="editView('${view.id}')">Edit</button>
                            ${!view.is_default ? `<button onclick="setDefaultView('${view.id}')">Set Default</button>` : ''}
                            <button class="danger" onclick="deleteView('${view.id}')">Delete</button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
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
    listContainer.innerHTML = allAccountsCache.map(acc => `
        <label class="checkbox-label">
            <input type="checkbox" name="view-account" value="${acc.id}">
            <span>${acc.name}</span>
            <span class="account-type">${acc.display_type}</span>
        </label>
    `).join('');

    document.getElementById('view-modal').style.display = 'flex';
}

function editView(viewId) {
    const view = availableViews.find(v => v.id === viewId);
    if (!view) return;

    document.getElementById('view-modal-title').textContent = 'Edit Portfolio View';
    document.getElementById('view-edit-id').value = viewId;
    document.getElementById('view-name').value = view.name;
    document.getElementById('view-is-default').checked = view.is_default;

    // Populate accounts checkboxes with current selections
    const listContainer = document.getElementById('view-accounts-list');
    listContainer.innerHTML = allAccountsCache.map(acc => `
        <label class="checkbox-label">
            <input type="checkbox" name="view-account" value="${acc.id}" ${view.account_ids.includes(acc.id) ? 'checked' : ''}>
            <span>${acc.name}</span>
            <span class="account-type">${acc.display_type}</span>
        </label>
    `).join('');

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
    const accountIds = Array.from(checkboxes).map(cb => cb.value);

    if (accountIds.length === 0) {
        showToast('Please select at least one account', 'error');
        return;
    }

    try {
        const url = editId
            ? `${API_BASE}/api/settings/views/${editId}`
            : `${API_BASE}/api/settings/views`;
        const method = editId ? 'PUT' : 'POST';

        const resp = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, account_ids: accountIds, is_default: isDefault })
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
            method: 'PUT'
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
            method: 'DELETE'
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

    const data = {
        dob: document.getElementById('settings-dob').value,
        retirement_age: parseInt(document.getElementById('settings-retirement-age').value)
    };

    try {
        await fetch(`${API_BASE}/api/settings/config/personal`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        showToast('Personal settings saved', 'success');
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
        cash: parseFloat(document.getElementById('target-cash').value) / 100
    };

    try {
        await fetch(`${API_BASE}/api/settings/config/targets/asset_class`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
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
        risk_free_rate: parseFloat(document.getElementById('market-risk-free').value) / 100
    };

    try {
        await fetch(`${API_BASE}/api/settings/config/market`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
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
        t_distribution_df: 5 // Keep default
    };

    try {
        await fetch(`${API_BASE}/api/settings/config/monte_carlo`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
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
                value: key
            })
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

    showLoading('Running Monte Carlo simulation...');
    const form = event.target;
    form.classList.add('loading');

    const params = {
        current_age: parseInt(document.getElementById('current-age').value),
        retirement_age: parseInt(document.getElementById('retirement-age').value),
        monthly_contribution: parseFloat(document.getElementById('monthly-contribution').value),
        monthly_withdrawal: parseFloat(document.getElementById('monthly-withdrawal').value),
        stock_allocation: parseFloat(document.getElementById('stock-allocation').value) / 100,
        bond_allocation: parseFloat(document.getElementById('bond-allocation').value) / 100
    };

    // Check if tax-aware mode is enabled
    const useTaxAware = document.getElementById('use-tax-aware')?.checked || false;

    if (useTaxAware) {
        params.use_tax_aware_withdrawals = true;
        params.account_balances = {
            taxable: parseFloat(document.getElementById('balance-taxable').value) || 0,
            traditional: parseFloat(document.getElementById('balance-traditional').value) || 0,
            roth: parseFloat(document.getElementById('balance-roth').value) || 0
        };
        params.tax_rate_ordinary = (parseFloat(document.getElementById('tax-rate-ordinary').value) || 22) / 100;
        params.tax_rate_capital_gains = (parseFloat(document.getElementById('tax-rate-cap-gains').value) || 15) / 100;
        params.tax_rate_state = (parseFloat(document.getElementById('tax-rate-state').value) || 5) / 100;
        params.cost_basis_ratio = (parseFloat(document.getElementById('cost-basis-ratio').value) || 60) / 100;
        params.contribution_traditional_pct = (parseFloat(document.getElementById('contrib-traditional').value) || 60) / 100;
        params.contribution_roth_pct = (parseFloat(document.getElementById('contrib-roth').value) || 25) / 100;
        params.contribution_taxable_pct = (parseFloat(document.getElementById('contrib-taxable').value) || 15) / 100;
    }

    try {
        const response = await fetch(`${API_BASE}/api/projections/monte-carlo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const result = await response.json();
        displayProjectionResults(result, params.retirement_age);

    } catch (error) {
        console.error('Error running projection:', error);
        showToast('Failed to run projection', 'error');
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
    successEl.className = 'stat-value ' + (successRate >= 90 ? 'text-success' : successRate >= 70 ? 'text-warning' : 'text-error');

    document.getElementById('median-final').textContent = formatCurrency(result.median_final_value);
    document.getElementById('worst-case').textContent = formatCurrency(result.worst_case_final);
    document.getElementById('best-case').textContent = formatCurrency(result.best_case_final);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const retirementIdx = result.ages.indexOf(retirementAge);

    Plotly.newPlot('chart-projection', [
        {
            x: result.ages,
            y: result.percentile_90,
            type: 'scatter',
            mode: 'lines',
            name: '90th %',
            line: { color: '#49aa19', width: 1 },
            fill: 'tonexty',
            fillcolor: 'rgba(73, 170, 25, 0.1)'
        },
        {
            x: result.ages,
            y: result.percentile_75,
            type: 'scatter',
            mode: 'lines',
            name: '75th %',
            line: { color: '#49aa19', width: 1 },
            fill: 'tonexty',
            fillcolor: 'rgba(73, 170, 25, 0.15)'
        },
        {
            x: result.ages,
            y: result.median_values,
            type: 'scatter',
            mode: 'lines',
            name: 'Median',
            line: { color: '#1668dc', width: 3 }
        },
        {
            x: result.ages,
            y: result.percentile_25,
            type: 'scatter',
            mode: 'lines',
            name: '25th %',
            line: { color: '#d89614', width: 1 },
            fill: 'tonexty',
            fillcolor: 'rgba(216, 150, 20, 0.15)'
        },
        {
            x: result.ages,
            y: result.percentile_10,
            type: 'scatter',
            mode: 'lines',
            name: '10th %',
            line: { color: '#dc4446', width: 1 },
            fill: 'tonexty',
            fillcolor: 'rgba(220, 68, 70, 0.1)'
        }
    ], {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' },
        margin: { t: 20, b: 40, l: 80, r: 20 },
        xaxis: {
            title: 'Age',
            gridcolor: isDark ? '#303030' : '#f0f0f0'
        },
        yaxis: {
            title: 'Portfolio Value',
            tickformat: '$,.0f',
            gridcolor: isDark ? '#303030' : '#f0f0f0'
        },
        legend: { orientation: 'h', y: 1.15 },
        shapes: retirementIdx >= 0 ? [{
            type: 'line',
            x0: retirementAge,
            x1: retirementAge,
            y0: 0,
            y1: 1,
            yref: 'paper',
            line: { color: isDark ? '#424242' : '#d9d9d9', width: 2, dash: 'dash' }
        }] : []
    }, plotlyConfig);
}

// FIRE calculator
async function calculateFire(event) {
    event.preventDefault();

    const params = {
        annual_spending: parseFloat(document.getElementById('annual-spending').value),
        monthly_contribution: parseFloat(document.getElementById('fire-contribution').value)
    };

    try {
        const response = await fetch(`${API_BASE}/api/projections/fire`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const result = await response.json();

        document.getElementById('fire-results').style.display = 'flex';
        document.getElementById('fire-number').textContent = formatCurrency(result.fire_number);
        document.getElementById('years-to-fire').textContent = result.years_to_fire === Infinity ? 'Never' : `${result.years_to_fire.toFixed(1)} years`;
        document.getElementById('fire-progress').textContent = `${result.progress_pct.toFixed(1)}%`;

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

    document.getElementById('stock-fields').style.display =
        (posType === 'equity' || posType === 'fund') ? 'block' : 'none';
    document.getElementById('cash-fields').style.display =
        posType === 'cash' ? 'block' : 'none';
    document.getElementById('cd-fields').style.display =
        posType === 'cd' ? 'block' : 'none';
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
            accounts.forEach(acc => {
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

        types.forEach(type => {
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
                brokerage: brokerage
            })
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

    const accountId = document.getElementById('position-account').value;
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
                name: name
            };
            if (apy !== null) {
                cashData.interest_rate = apy;
            }

            response = await fetch(`${API_BASE}/api/portfolio/positions/cash`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cashData)
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
                    maturity_date: maturity
                })
            });
        } else {
            // Add stock/fund position
            const ticker = document.getElementById('position-ticker').value.trim().toUpperCase();
            const name = document.getElementById('position-name').value.trim() || null;
            const shares = parseFloat(document.getElementById('position-shares').value);
            const price = document.getElementById('position-price').value ?
                parseFloat(document.getElementById('position-price').value) : null;
            const costBasis = document.getElementById('position-cost-basis').value ?
                parseFloat(document.getElementById('position-cost-basis').value) : null;
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
                    position_type: posType
                })
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

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await loadProfiles();  // Load profiles for multi-database support
    await loadViews();  // Load views first to set up view selector
    await updatePriceStatus();  // Show price freshness status
    await checkDemoModeStatus();  // Check demo mode status
    refreshData();
});
