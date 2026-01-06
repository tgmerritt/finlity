/**
 * Social Media Feed Carousel
 * Displays curated financial literacy content from YouTube, Instagram, and TikTok.
 *
 * Content Guidelines:
 * - INCLUDE: Financial literacy, tax optimization, portfolio basics, Bogleheads, CFPs/fiduciaries, estate planning
 * - EXCLUDE: Crypto, alt-coins, options, futures, betting platforms, "get rich quick" schemes
 */

import { getElementById, clearElement, createElement } from '@/utils/html';

// ============================================
// Types
// ============================================

type Platform = 'youtube' | 'instagram' | 'tiktok';

interface Creator {
  id: string;
  name: string;
  handle: string;
  platform: Platform;
  topic: string;
  profileUrl: string;
  /** YouTube video ID, Instagram post shortcode, or TikTok video ID */
  embedId: string;
  /** Optional description shown in embed placeholder */
  description?: string;
}

// ============================================
// Creator Configuration
// ============================================

/**
 * Curated list of financial literacy creators.
 * All creators have been vetted to focus on fundamentals, long-term investing,
 * and sound financial principles (Bogleheads, value investing, tax optimization).
 */
const CREATORS: Creator[] = [
  // YouTube Creators - Primary (most reliable embeds)
  {
    id: 'ben-felix',
    name: 'Ben Felix',
    handle: '@BenFelixCSI',
    platform: 'youtube',
    topic: 'Evidence-Based Investing',
    profileUrl: 'https://www.youtube.com/@BenFelixCSI',
    embedId: 'fvGLnthJDsg',
    description: 'Research-backed investment insights',
  },
  {
    id: 'plain-bagel',
    name: 'The Plain Bagel',
    handle: '@ThePlainBagel',
    platform: 'youtube',
    topic: 'Investment Education',
    profileUrl: 'https://www.youtube.com/@ThePlainBagel',
    embedId: '2I6FEFLr-xE',
    description: 'Clear explanations of investing basics',
  },
  {
    id: 'money-guy',
    name: 'The Money Guy Show',
    handle: '@MoneyGuyShow',
    platform: 'youtube',
    topic: 'Wealth Building',
    profileUrl: 'https://www.youtube.com/@MoneyGuyShow',
    embedId: '8K-hLxTZuvc',
    description: 'CFPs Brian Preston & Bo Hanson',
  },
  {
    id: 'two-cents',
    name: 'Two Cents',
    handle: '@TwoCentsPBS',
    platform: 'youtube',
    topic: 'Personal Finance',
    profileUrl: 'https://www.youtube.com/@TwoCentsPBS',
    embedId: 'Hfb_RCWZ8qg',
    description: 'PBS Digital Studios',
  },
  {
    id: 'rob-berger',
    name: 'Rob Berger',
    handle: '@RobBergerFI',
    platform: 'youtube',
    topic: 'Financial Independence',
    profileUrl: 'https://www.youtube.com/@RobBergerFI',
    embedId: 'dZPqQKyPMjg',
    description: 'Former Forbes editor, Bogleheads',
  },
  {
    id: 'swedish-investor',
    name: 'The Swedish Investor',
    handle: '@TheSwedishInvestor',
    platform: 'youtube',
    topic: 'Book Summaries',
    profileUrl: 'https://www.youtube.com/@TheSwedishInvestor',
    embedId: 'npoyc_X5zO8',
    description: 'Buffett & Munger book breakdowns',
  },
  // Instagram Creators
  {
    id: 'personalfinanceclub',
    name: 'Personal Finance Club',
    handle: '@personalfinanceclub',
    platform: 'instagram',
    topic: 'Index Fund Investing',
    profileUrl: 'https://www.instagram.com/personalfinanceclub/',
    embedId: 'CvKqNh4gW9p',
    description: 'Simple investing visuals',
  },
  {
    id: 'thebudgetnista',
    name: 'The Budgetnista',
    handle: '@thebudgetnista',
    platform: 'instagram',
    topic: 'Budgeting Basics',
    profileUrl: 'https://www.instagram.com/thebudgetnista/',
    embedId: 'C0kB3qPqNXa',
    description: 'Tiffany Aliche on budgeting',
  },
  // TikTok Creators
  {
    id: 'humphrey-yang',
    name: 'Humphrey Yang',
    handle: '@humphreytalks',
    platform: 'tiktok',
    topic: 'Tax Tips & Basics',
    profileUrl: 'https://www.tiktok.com/@humphreytalks',
    embedId: '7298321654789123334',
    description: 'Quick tax tips',
  },
  {
    id: 'yourrichbff',
    name: 'Your Rich BFF',
    handle: '@yourrichbff',
    platform: 'tiktok',
    topic: 'Financial Fundamentals',
    profileUrl: 'https://www.tiktok.com/@yourrichbff',
    embedId: '7302145678912345678',
    description: 'Vivian Tu on finance basics',
  },
];

// ============================================
// Configuration
// ============================================

const CONFIG = {
  /** Number of cards to display (duplicated for infinite scroll) */
  cardsToShow: 6,
  /** Seconds for one full scroll cycle */
  scrollDuration: 60,
  /** Pause animation on hover */
  pauseOnHover: true,
};

// ============================================
// State
// ============================================

let selectedCreators: Creator[] = [];
let observer: IntersectionObserver | null = null;

// ============================================
// Helper Functions
// ============================================

/**
 * Shuffle array using Fisher-Yates algorithm.
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j] as T;
    shuffled[j] = temp as T;
  }
  return shuffled;
}

/**
 * Select random subset of creators, ensuring platform diversity.
 */
function selectRandomCreators(count: number): Creator[] {
  const youtube = CREATORS.filter((c) => c.platform === 'youtube');
  const others = CREATORS.filter((c) => c.platform !== 'youtube');

  const shuffledYoutube = shuffleArray(youtube).slice(0, Math.min(4, youtube.length));
  const shuffledOthers = shuffleArray(others).slice(0, Math.max(0, count - shuffledYoutube.length));

  return shuffleArray([...shuffledYoutube, ...shuffledOthers]).slice(0, count);
}

/**
 * Generate embed URL based on platform.
 */
function getEmbedUrl(creator: Creator): string {
  switch (creator.platform) {
    case 'youtube':
      return `https://www.youtube.com/embed/${encodeURIComponent(creator.embedId)}?rel=0&modestbranding=1`;
    case 'instagram':
      return `https://www.instagram.com/p/${encodeURIComponent(creator.embedId)}/embed`;
    case 'tiktok':
      return `https://www.tiktok.com/embed/v2/${encodeURIComponent(creator.embedId)}`;
    default: {
      // Exhaustive check - TypeScript will error if a new platform is added but not handled
      const exhaustiveCheck: never = creator.platform;
      console.error(`[SocialFeed] Unhandled platform: ${exhaustiveCheck}`);
      return '';
    }
  }
}

/**
 * Create platform icon SVG element.
 */
function createPlatformIcon(platform: Platform): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'currentColor');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

  switch (platform) {
    case 'youtube':
      path.setAttribute(
        'd',
        'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z'
      );
      break;
    case 'instagram':
      path.setAttribute(
        'd',
        'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z'
      );
      break;
    case 'tiktok':
      path.setAttribute(
        'd',
        'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z'
      );
      break;
  }

  svg.appendChild(path);
  return svg;
}

// ============================================
// Card Rendering (Safe DOM Methods)
// ============================================

/**
 * Create a social card element using safe DOM methods.
 */
function createSocialCard(creator: Creator): HTMLElement {
  const card = createElement('div', { class: 'social-card' });
  card.setAttribute('data-creator-id', creator.id);
  card.setAttribute('data-platform', creator.platform);

  // Header
  const header = createElement('div', { class: 'social-card-header' });

  // Avatar (using platform icon as placeholder)
  const avatar = createElement('div', { class: 'creator-avatar' });
  avatar.style.display = 'flex';
  avatar.style.alignItems = 'center';
  avatar.style.justifyContent = 'center';
  avatar.style.background = 'var(--color-primary-bg)';
  avatar.appendChild(createPlatformIcon(creator.platform));

  // Creator info
  const info = createElement('div', { class: 'creator-info' });
  const nameSpan = createElement('span', { class: 'creator-name' });
  nameSpan.textContent = creator.name;
  const handleSpan = createElement('span', { class: 'creator-handle' });
  handleSpan.textContent = creator.handle;
  info.appendChild(nameSpan);
  info.appendChild(handleSpan);

  // Platform badge
  const badge = createElement('span', { class: `platform-badge ${creator.platform}` });
  badge.appendChild(createPlatformIcon(creator.platform));

  header.appendChild(avatar);
  header.appendChild(info);
  header.appendChild(badge);

  // Embed container
  const embedContainer = createElement('div', { class: 'social-card-embed' });
  embedContainer.setAttribute('data-embed-loaded', 'false');
  embedContainer.setAttribute('data-embed-url', getEmbedUrl(creator));

  const placeholder = createElement('div', { class: 'embed-placeholder' });
  const spinner = createElement('div', { class: 'embed-loading-spinner' });
  const descSpan = createElement('span');
  descSpan.textContent = creator.description || 'Financial education content';
  placeholder.appendChild(spinner);
  placeholder.appendChild(descSpan);
  embedContainer.appendChild(placeholder);

  // Footer
  const footer = createElement('div', { class: 'social-card-footer' });
  const topicSpan = createElement('span', { class: 'creator-topic' });
  topicSpan.textContent = creator.topic;
  const followLink = createElement('a', {
    class: 'follow-link',
    href: creator.profileUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  followLink.textContent = 'Follow';
  footer.appendChild(topicSpan);
  footer.appendChild(followLink);

  // Assemble card
  card.appendChild(header);
  card.appendChild(embedContainer);
  card.appendChild(footer);

  // Load embed on hover for better UX
  card.addEventListener(
    'mouseenter',
    () => {
      const embed = card.querySelector('.social-card-embed') as HTMLElement;
      if (embed && embed.getAttribute('data-embed-loaded') !== 'true') {
        loadEmbed(embed);
      }
    },
    { once: true }
  );

  return card;
}

/**
 * Load embed content into card.
 */
function loadEmbed(embedContainer: HTMLElement): void {
  if (embedContainer.getAttribute('data-embed-loaded') === 'true') return;

  const embedUrl = embedContainer.getAttribute('data-embed-url');
  if (!embedUrl) {
    console.warn('[SocialFeed] Embed container missing data-embed-url attribute');
    // Show error state instead of infinite spinner
    const placeholder = embedContainer.querySelector('.embed-placeholder');
    if (placeholder) {
      const spinner = placeholder.querySelector('.embed-loading-spinner');
      if (spinner) spinner.remove();
      const text = placeholder.querySelector('span');
      if (text) text.textContent = 'Content unavailable';
    }
    return;
  }

  const iframe = createElement('iframe');
  iframe.src = embedUrl;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute(
    'allow',
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
  );
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('loading', 'lazy');
  // Security: Sandbox third-party content with minimal permissions
  // allow-popups needed for social embed links/buttons to open in new windows
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox'
  );

  // Handle iframe load errors
  iframe.addEventListener('error', () => {
    console.error(`[SocialFeed] Failed to load embed: ${embedUrl}`);
    embedContainer.setAttribute('data-embed-loaded', 'error');
  });

  // Remove placeholder and add iframe
  const placeholder = embedContainer.querySelector('.embed-placeholder');
  if (placeholder) {
    placeholder.remove();
  }
  embedContainer.appendChild(iframe);
  embedContainer.setAttribute('data-embed-loaded', 'true');
}

// ============================================
// Carousel Logic
// ============================================

/**
 * Initialize the carousel with selected creators.
 */
function initCarouselContent(): void {
  const track = getElementById<HTMLElement>('carousel-track');
  if (!track) {
    console.error('[SocialFeed] Cannot render cards: #carousel-track not found');
    return;
  }

  clearElement(track);
  selectedCreators = selectRandomCreators(CONFIG.cardsToShow);

  // Create cards twice for seamless infinite scroll
  const allCards = [...selectedCreators, ...selectedCreators];

  allCards.forEach((creator) => {
    const card = createSocialCard(creator);
    track.appendChild(card);
  });

  // Set up lazy loading for embeds
  setupLazyLoading();
}

/**
 * Set up IntersectionObserver for lazy loading embeds.
 */
function setupLazyLoading(): void {
  if (observer) {
    observer.disconnect();
  }

  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const card = entry.target as HTMLElement;
          const embedContainer = card.querySelector('.social-card-embed') as HTMLElement;
          if (embedContainer && embedContainer.getAttribute('data-embed-loaded') !== 'true') {
            setTimeout(() => {
              if (embedContainer.getAttribute('data-embed-loaded') !== 'true') {
                loadEmbed(embedContainer);
              }
            }, 1000);
          }
        }
      });
    },
    {
      threshold: 0.1,
      rootMargin: '100px',
    }
  );

  document.querySelectorAll('.social-card').forEach((card) => {
    observer?.observe(card);
  });
}

/**
 * Manual navigation controls - scroll by one card width.
 */
function scrollCarousel(direction: 'prev' | 'next'): void {
  const track = getElementById<HTMLElement>('carousel-track');
  if (!track) {
    console.warn('[SocialFeed] Scroll attempted but #carousel-track not found');
    return;
  }

  // Calculate actual card width dynamically for responsive support
  const firstCard = track.querySelector('.social-card') as HTMLElement | null;
  const trackStyle = getComputedStyle(track);
  const gap = parseFloat(trackStyle.gap) || 24;
  const cardWidth = firstCard ? firstCard.offsetWidth + gap : 344;

  track.style.animationPlayState = 'paused';

  const transformValue = trackStyle.transform;
  let currentX = 0;
  if (transformValue && transformValue !== 'none') {
    const matrix = new DOMMatrix(transformValue);
    currentX = matrix.m41;
  }

  const newX = direction === 'next' ? currentX - cardWidth : currentX + cardWidth;

  track.style.animation = 'none';
  track.style.transform = `translateX(${newX}px)`;

  setTimeout(() => {
    track.style.animation = '';
    track.style.animationPlayState = 'running';
  }, 3000);
}

// ============================================
// Initialization
// ============================================

/**
 * Initialize the social feed carousel.
 */
export function initSocialFeed(): void {
  const carousel = getElementById<HTMLElement>('social-feed-carousel');
  if (!carousel) {
    return;
  }

  initCarouselContent();

  const prevBtn = getElementById<HTMLButtonElement>('carousel-prev');
  const nextBtn = getElementById<HTMLButtonElement>('carousel-next');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => scrollCarousel('prev'));
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => scrollCarousel('next'));
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (prefersReducedMotion.matches) {
    const track = getElementById<HTMLElement>('carousel-track');
    if (track) {
      track.style.animation = 'none';
    }
  }

  console.debug('Social feed carousel initialized');
}

/**
 * Clean up the social feed (for SPA navigation).
 */
export function destroySocialFeed(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  selectedCreators = [];
}

/**
 * Refresh the carousel with new random creators.
 */
export function refreshSocialFeed(): void {
  destroySocialFeed();
  initCarouselContent();
}
