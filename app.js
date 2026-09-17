/* =============================================================
   コーデ発掘 — App Logic (季節対応版)
   IndexedDB for images, swipe gestures, favorites management
   Items & favorites are stored per season.
   ============================================================= */

(() => {
  'use strict';

  // ── IndexedDB Setup ──────────────────────────────────────────
  const DB_NAME = 'ClosetCoordDB';
  const DB_VERSION = 2; // Bumped for season support
  const STORE_ITEMS = 'items';      // {id, category, season, blob, timestamp}
  const STORE_FAVS = 'favorites';   // {id, topId, bottomId, season, timestamp}

  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;

        // Items store
        if (!d.objectStoreNames.contains(STORE_ITEMS)) {
          const store = d.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('season', 'season', { unique: false });
          store.createIndex('season_category', ['season', 'category'], { unique: false });
        } else {
          const tx = e.target.transaction;
          const store = tx.objectStore(STORE_ITEMS);
          if (!store.indexNames.contains('season')) {
            store.createIndex('season', 'season', { unique: false });
          }
          if (!store.indexNames.contains('season_category')) {
            store.createIndex('season_category', ['season', 'category'], { unique: false });
          }
        }

        // Favorites store
        if (!d.objectStoreNames.contains(STORE_FAVS)) {
          const store = d.createObjectStore(STORE_FAVS, { keyPath: 'id' });
          store.createIndex('season', 'season', { unique: false });
        } else {
          const tx = e.target.transaction;
          const store = tx.objectStore(STORE_FAVS);
          if (!store.indexNames.contains('season')) {
            store.createIndex('season', 'season', { unique: false });
          }
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbAdd(storeName, data) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).add(data);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function dbDelete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetByIndex(storeName, indexName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const idx = tx.objectStore(storeName).index(indexName);
      const req = idx.getAll(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGet(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ── Utility ──────────────────────────────────────────────────
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function blobToObjectURL(blob) {
    return URL.createObjectURL(blob);
  }

  function readFileAsBlob(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX = 800;
        let w = img.width;
        let h = img.height;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(blob);
        }, 'image/jpeg', 0.82);
      };
      img.src = url;
    });
  }

  const SEASON_LABELS = {
    spring: '🌸 春',
    summer: '🌻 夏',
    autumn: '🍂 秋',
    winter: '❄️ 冬'
  };

  // ── Toast ────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    clearTimeout(toastTimer);
    requestAnimationFrame(() => {
      el.classList.add('show');
      toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
    });
  }

  // ── Modal ────────────────────────────────────────────────────
  const modalOverlay = document.getElementById('modal-overlay');
  const modalMessage = document.getElementById('modal-message');
  const modalCancel = document.getElementById('modal-cancel');
  const modalConfirm = document.getElementById('modal-confirm');
  let modalResolve = null;

  function showModal(msg) {
    return new Promise((resolve) => {
      modalMessage.textContent = msg;
      modalOverlay.classList.remove('hidden');
      modalResolve = resolve;
    });
  }

  modalCancel.addEventListener('click', () => {
    modalOverlay.classList.add('hidden');
    if (modalResolve) modalResolve(false);
  });

  modalConfirm.addEventListener('click', () => {
    modalOverlay.classList.add('hidden');
    if (modalResolve) modalResolve(true);
  });

  // ── Season State ─────────────────────────────────────────────
  // Each tab maintains its own selected season
  const seasonState = {
    closet: 'spring',
    swipe: 'spring',
    favs: 'spring'
  };

  // Initialize season selectors
  function initSeasonBars() {
    const bars = {
      closet: document.getElementById('season-bar-closet'),
      swipe: document.getElementById('season-bar-swipe'),
      favs: document.getElementById('season-bar-favs')
    };

    for (const [tab, bar] of Object.entries(bars)) {
      const chips = bar.querySelectorAll('.season-chip');
      chips.forEach(chip => {
        chip.addEventListener('click', () => {
          // Update active state
          chips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          seasonState[tab] = chip.dataset.season;

          // Trigger refresh for the tab
          if (tab === 'closet') renderAllGalleries();
          if (tab === 'swipe') initSwipe();
          if (tab === 'favs') renderFavs();
        });
      });
    }
  }

  // ── Tab Navigation ──────────────────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  function switchTab(tabName) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    tabContents.forEach(tc => {
      tc.classList.toggle('active', tc.id === `tab-${tabName}`);
    });
    if (tabName === 'swipe') initSwipe();
    if (tabName === 'favs') renderFavs();
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Closet: Image Upload & Gallery ──────────────────────────
  const inputTops = document.getElementById('input-tops');
  const inputBottoms = document.getElementById('input-bottoms');
  const galleryTops = document.getElementById('gallery-tops');
  const galleryBottoms = document.getElementById('gallery-bottoms');
  const topsCount = document.getElementById('tops-count');
  const bottomsCount = document.getElementById('bottoms-count');

  inputTops.addEventListener('change', (e) => handleUpload(e, 'tops'));
  inputBottoms.addEventListener('change', (e) => handleUpload(e, 'bottoms'));

  async function handleUpload(e, category) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const season = seasonState.closet;

    for (const file of files) {
      const blob = await readFileAsBlob(file);
      const item = {
        id: uid(),
        category,
        season,
        blob,
        timestamp: Date.now()
      };
      await dbAdd(STORE_ITEMS, item);
    }
    e.target.value = '';
    await renderGallery(category);
    showToast(`${SEASON_LABELS[season]} に ${files.length}枚追加`);
  }

  async function renderGallery(category) {
    const season = seasonState.closet;
    const items = await dbGetByIndex(STORE_ITEMS, 'season_category', [season, category]);
    const gallery = category === 'tops' ? galleryTops : galleryBottoms;
    const countEl = category === 'tops' ? topsCount : bottomsCount;

    // Revoke old object URLs
    gallery.querySelectorAll('img').forEach(img => {
      if (img._objectURL) URL.revokeObjectURL(img._objectURL);
    });

    gallery.innerHTML = '';
    countEl.textContent = items.length;

    items.sort((a, b) => b.timestamp - a.timestamp);

    items.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'gallery-thumb';
      div.style.animationDelay = `${i * 0.04}s`;

      const img = document.createElement('img');
      const objURL = blobToObjectURL(item.blob);
      img.src = objURL;
      img._objectURL = objURL;
      img.alt = category === 'tops' ? 'トップス' : 'ボトムス';
      img.loading = 'lazy';

      const badge = document.createElement('button');
      badge.className = 'delete-badge visible';
      badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="round"/></svg>';

      badge.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const ok = await showModal('この画像を削除しますか？');
        if (ok) {
          await dbDelete(STORE_ITEMS, item.id);
          URL.revokeObjectURL(objURL);
          await renderGallery(category);
          showToast('削除しました');
        }
      });

      div.appendChild(img);
      div.appendChild(badge);
      gallery.appendChild(div);
    });
  }

  async function renderAllGalleries() {
    await renderGallery('tops');
    await renderGallery('bottoms');
  }

  // ── Swipe Screen ────────────────────────────────────────────
  const swipeEmpty = document.getElementById('swipe-empty');
  const swipeEmptyMsg = document.getElementById('swipe-empty-msg');
  const swipeArea = document.getElementById('swipe-area');
  const swipeCard = document.getElementById('swipe-card');
  const swipeTopImg = document.getElementById('swipe-top-img');
  const swipeBottomImg = document.getElementById('swipe-bottom-img');
  const overlayNope = document.getElementById('overlay-nope');
  const overlayLike = document.getElementById('overlay-like');
  const btnNope = document.getElementById('btn-nope');
  const btnLike = document.getElementById('btn-like');
  const comboCounter = document.getElementById('combo-counter');

  let currentTop = null;
  let currentBottom = null;
  let topsList = [];
  let bottomsList = [];
  let shownCombos = new Set();
  let totalPossible = 0;

  let swipeTopURL = null;
  let swipeBottomURL = null;

  async function initSwipe() {
    const season = seasonState.swipe;
    topsList = await dbGetByIndex(STORE_ITEMS, 'season_category', [season, 'tops']);
    bottomsList = await dbGetByIndex(STORE_ITEMS, 'season_category', [season, 'bottoms']);

    if (topsList.length === 0 || bottomsList.length === 0) {
      swipeEmpty.style.display = 'flex';
      swipeArea.classList.add('hidden');
      const label = SEASON_LABELS[season];
      swipeEmptyMsg.innerHTML = `${label} のトップスとボトムスを<br>それぞれ1枚以上追加してね`;
      return;
    }

    swipeEmpty.style.display = 'none';
    swipeArea.classList.remove('hidden');
    totalPossible = topsList.length * bottomsList.length;
    shownCombos.clear();

    showNextCombo();
  }

  function showNextCombo() {
    if (topsList.length === 0 || bottomsList.length === 0) return;

    if (shownCombos.size >= totalPossible) {
      shownCombos.clear();
      showToast('全組み合わせ一周しました！');
    }

    let attempts = 0;
    do {
      currentTop = topsList[Math.floor(Math.random() * topsList.length)];
      currentBottom = bottomsList[Math.floor(Math.random() * bottomsList.length)];
      attempts++;
    } while (shownCombos.has(`${currentTop.id}_${currentBottom.id}`) && attempts < 200);

    shownCombos.add(`${currentTop.id}_${currentBottom.id}`);

    if (swipeTopURL) URL.revokeObjectURL(swipeTopURL);
    if (swipeBottomURL) URL.revokeObjectURL(swipeBottomURL);

    swipeTopURL = blobToObjectURL(currentTop.blob);
    swipeBottomURL = blobToObjectURL(currentBottom.blob);
    swipeTopImg.src = swipeTopURL;
    swipeBottomImg.src = swipeBottomURL;

    comboCounter.textContent = `${shownCombos.size} / ${totalPossible} 通り`;

    swipeCard.style.transform = '';
    swipeCard.classList.remove('animating', 'returning');
    overlayNope.style.opacity = '0';
    overlayLike.style.opacity = '0';
  }

  // ── Swipe Gesture Handling ──────────────────────────────────
  let startX = 0;
  let currentDragX = 0;
  let isDragging = false;

  swipeCard.addEventListener('pointerdown', onPointerDown);

  function onPointerDown(e) {
    if (swipeCard.classList.contains('animating')) return;
    isDragging = true;
    startX = e.clientX;
    currentDragX = 0;
    swipeCard.classList.remove('returning');
    swipeCard.setPointerCapture(e.pointerId);

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    currentDragX = dx;
    const rotation = dx * 0.08;
    const maxOpacity = Math.min(Math.abs(dx) / 120, 1);

    swipeCard.style.transform = `translateX(${dx}px) rotate(${rotation}deg)`;

    if (dx < 0) {
      overlayNope.style.opacity = maxOpacity;
      overlayLike.style.opacity = '0';
    } else {
      overlayLike.style.opacity = maxOpacity;
      overlayNope.style.opacity = '0';
    }
  }

  function onPointerUp() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);

    const threshold = 80;
    if (currentDragX < -threshold) {
      animateOut('left');
    } else if (currentDragX > threshold) {
      animateOut('right');
    } else {
      swipeCard.classList.add('returning');
      swipeCard.style.transform = '';
      overlayNope.style.opacity = '0';
      overlayLike.style.opacity = '0';
    }
  }

  function animateOut(direction) {
    swipeCard.classList.add('animating');
    const offscreen = direction === 'left' ? -window.innerWidth * 1.5 : window.innerWidth * 1.5;
    const rotation = direction === 'left' ? -30 : 30;
    swipeCard.style.transform = `translateX(${offscreen}px) rotate(${rotation}deg)`;

    if (direction === 'right') {
      saveFavorite();
    }

    setTimeout(() => {
      showNextCombo();
    }, 300);
  }

  btnNope.addEventListener('click', () => {
    if (swipeCard.classList.contains('animating')) return;
    animateOut('left');
  });

  btnLike.addEventListener('click', () => {
    if (swipeCard.classList.contains('animating')) return;
    animateOut('right');
  });

  // ── Favorites ───────────────────────────────────────────────
  async function saveFavorite() {
    if (!currentTop || !currentBottom) return;
    const fav = {
      id: uid(),
      topId: currentTop.id,
      bottomId: currentBottom.id,
      season: seasonState.swipe,
      timestamp: Date.now()
    };
    await dbAdd(STORE_FAVS, fav);
    showToast('♥ お気に入りに保存！');
  }

  const favsEmpty = document.getElementById('favs-empty');
  const favsList = document.getElementById('favs-list');

  async function renderFavs() {
    const season = seasonState.favs;
    const favs = await dbGetByIndex(STORE_FAVS, 'season', season);
    favs.sort((a, b) => b.timestamp - a.timestamp);

    // Clean previous object URLs
    favsList.querySelectorAll('img').forEach(img => {
      if (img._objectURL) URL.revokeObjectURL(img._objectURL);
    });

    favsList.innerHTML = '';

    // Filter out orphaned favs (deleted items)
    const validFavs = [];
    for (const fav of favs) {
      const topItem = await dbGet(STORE_ITEMS, fav.topId);
      const bottomItem = await dbGet(STORE_ITEMS, fav.bottomId);
      if (!topItem || !bottomItem) {
        await dbDelete(STORE_FAVS, fav.id);
        continue;
      }
      validFavs.push({ fav, topItem, bottomItem });
    }

    if (validFavs.length === 0) {
      favsEmpty.style.display = 'flex';
      favsList.style.display = 'none';
      return;
    }

    favsEmpty.style.display = 'none';
    favsList.style.display = 'flex';

    validFavs.forEach(({ fav, topItem, bottomItem }, i) => {
      const card = document.createElement('div');
      card.className = 'fav-card';
      card.style.animationDelay = `${i * 0.05}s`;

      const topURL = blobToObjectURL(topItem.blob);
      const bottomURL = blobToObjectURL(bottomItem.blob);

      const date = new Date(fav.timestamp);
      const dateStr = `${date.getFullYear()}/${(date.getMonth()+1).toString().padStart(2,'0')}/${date.getDate().toString().padStart(2,'0')}`;

      card.innerHTML = `
        <div class="fav-images">
          <div class="fav-img-wrapper">
            <img src="${topURL}" alt="トップス" loading="lazy">
            <span class="fav-img-label">トップス</span>
          </div>
          <div class="fav-img-wrapper">
            <img src="${bottomURL}" alt="ボトムス" loading="lazy">
            <span class="fav-img-label">ボトムス</span>
          </div>
        </div>
        <div class="fav-card-footer">
          <span class="fav-date">${dateStr}</span>
          <button class="fav-delete-btn" aria-label="削除">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        </div>
      `;

      card.querySelectorAll('img').forEach((img, idx) => {
        img._objectURL = idx === 0 ? topURL : bottomURL;
      });

      const delBtn = card.querySelector('.fav-delete-btn');
      delBtn.addEventListener('click', async () => {
        const ok = await showModal('このコーデをお気に入りから削除しますか？');
        if (ok) {
          card.classList.add('removing');
          setTimeout(async () => {
            await dbDelete(STORE_FAVS, fav.id);
            await renderFavs();
            showToast('削除しました');
          }, 350);
        }
      });

      favsList.appendChild(card);
    });
  }

  // ── Keyboard shortcuts ──────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const activeTab = document.querySelector('.tab-content.active');
    if (activeTab && activeTab.id === 'tab-swipe') {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        btnNope.click();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        btnLike.click();
      }
    }
  });

  // ── Init ────────────────────────────────────────────────────
  initSeasonBars();

  openDB().then(async () => {
    await renderAllGalleries();
  }).catch(err => {
    console.error('DB error:', err);
    showToast('データベースの初期化に失敗しました');
  });
})();
