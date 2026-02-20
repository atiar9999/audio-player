// ==================== GLOBAL VARIABLES ====================
let audio = new Audio();
let tracks = [];                 // array of { name, fileHandle, file, url?, pictureUrl? }
let currentTrackIndex = -1;
let playlistOrder = [];
let shuffle = false;
let repeatMode = 'none';
let folderHandle = null;
let visualizerCtx = null;
let visualizerAnalyser = null;
let visualizerSource = null;
let animationFrame = null;

// DOM elements
const folderPickerBtn = document.getElementById('folder-picker');
const fallbackInput = document.getElementById('fallback-folder-input');
const refreshBtn = document.getElementById('refresh-folder');
const themeToggle = document.getElementById('theme-toggle');
const trackListContainer = document.getElementById('track-list-container');
const searchInput = document.getElementById('search-input');
const currentTrackName = document.getElementById('current-track-name');
const currentTrackArtist = document.getElementById('current-track-artist');
const playPauseBtn = document.getElementById('play-pause-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const shuffleBtn = document.getElementById('shuffle-btn');
const repeatBtn = document.getElementById('repeat-btn');
const muteBtn = document.getElementById('mute-btn');
const volumeSlider = document.getElementById('volume-slider');
const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const currentTimeSpan = document.getElementById('current-time');
const durationSpan = document.getElementById('duration');
const thumbnailDiv = document.getElementById('album-thumbnail');
const visualizerCanvas = document.getElementById('visualizer');

// ==================== INITIAL SETUP ====================
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    themeToggle.innerHTML = savedTheme === 'light' ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';

    folderPickerBtn.addEventListener('click', selectFolder);
    refreshBtn.addEventListener('click', refreshFolder);
    themeToggle.addEventListener('click', toggleTheme);
    searchInput.addEventListener('input', filterTracks);
    playPauseBtn.addEventListener('click', togglePlayPause);
    prevBtn.addEventListener('click', playPrevious);
    nextBtn.addEventListener('click', playNext);
    shuffleBtn.addEventListener('click', toggleShuffle);
    repeatBtn.addEventListener('click', toggleRepeat);
    muteBtn.addEventListener('click', toggleMute);
    volumeSlider.addEventListener('input', (e) => { audio.volume = e.target.value; updateMuteIcon(); });
    progressBar.addEventListener('click', seek);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('ended', handleTrackEnd);
    audio.addEventListener('play', () => updatePlayPauseIcon(true));
    audio.addEventListener('pause', () => updatePlayPauseIcon(false));
    document.addEventListener('keydown', handleKeyboard);

    audio.volume = volumeSlider.value;
});

// ==================== FOLDER SELECTION ====================
async function selectFolder() {
    try {
        if ('showDirectoryPicker' in window) {
            folderHandle = await window.showDirectoryPicker();
            await loadTracksFromHandle(folderHandle);
        } else {
            fallbackInput.click();
            fallbackInput.onchange = async (e) => {
                const files = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.mp3'));
                processFiles(files);
            };
        }
    } catch (err) {
        console.warn('Folder selection cancelled or failed', err);
    }
}

async function loadTracksFromHandle(handle) {
    tracks = [];
    const files = await getMP3FilesRecursively(handle);
    processFiles(files);
}

async function getMP3FilesRecursively(dirHandle) {
    const mp3Files = [];
    for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.mp3')) {
            mp3Files.push(entry);
        } else if (entry.kind === 'directory') {
            const subFiles = await getMP3FilesRecursively(entry);
            mp3Files.push(...subFiles);
        }
    }
    return mp3Files;
}

function processFiles(files) {
    tracks = files.map((fileOrHandle, index) => ({
        id: index,
        name: fileOrHandle.name.replace(/\.mp3$/i, ''),
        fileHandle: fileOrHandle,
        file: null,
        url: null,
        pictureUrl: null,      // will be filled by metadata reader
        artist: null,
        title: null
    }));

    updatePlaylistOrder();
    renderTrackList();
    refreshBtn.disabled = false;

    // Start loading metadata in the background (with concurrency limit)
    loadAllMetadata();

    if (tracks.length > 0) {
        currentTrackIndex = 0;
        loadTrack(0);
    } else {
        showPlaceholder('No MP3 files found in the selected folder.');
    }
}

// ==================== METADATA EXTRACTION ====================
async function loadAllMetadata() {
    const concurrency = 5; // number of parallel reads
    for (let i = 0; i < tracks.length; i += concurrency) {
        const batch = tracks.slice(i, i + concurrency);
        await Promise.all(batch.map(track => readTrackMetadata(track)));
    }
}

async function readTrackMetadata(track) {
    try {
        // Obtain the actual File object
        let file;
        if (track.fileHandle instanceof FileSystemFileHandle) {
            file = await track.fileHandle.getFile();
        } else {
            file = track.fileHandle; // fallback File object
        }

        // Use jsmediatags to read ID3 tags
        const tags = await new Promise((resolve, reject) => {
            window.jsmediatags.read(file, {
                onSuccess: resolve,
                onError: reject
            });
        });

        // Extract artist and title
        const tag = tags.tags;
        if (tag.artist) track.artist = tag.artist;
        if (tag.title) track.title = tag.title;

        // Extract picture if available
        if (tag.picture) {
            const { data, format } = tag.picture;
            let base64String = '';
            for (let i = 0; i < data.length; i++) {
                base64String += String.fromCharCode(data[i]);
            }
            const base64 = btoa(base64String);
            const imageUrl = `data:${format};base64,${base64}`;
            track.pictureUrl = imageUrl;
        }

        // Update the track list thumbnail for this track
        updateTrackThumbnailInList(track);
    } catch (err) {
        // No metadata or error – ignore, we keep the coloured fallback
        console.debug(`No metadata for ${track.name}`, err);
    }
}

// Helper: find the DOM element for a given track and update its thumbnail image
function updateTrackThumbnailInList(track) {
    const trackItem = document.querySelector(`.track-item[data-track-id="${track.id}"]`);
    if (!trackItem) return; // not currently visible (filtered out)

    const thumbDiv = trackItem.querySelector('.track-thumb');
    if (track.pictureUrl) {
        // Replace the coloured div with an <img>
        thumbDiv.innerHTML = `<img src="${track.pictureUrl}" alt="cover">`;
        thumbDiv.style.background = 'none'; // remove colour
    } else {
        // Keep coloured letter, but ensure no leftover image
        if (!thumbDiv.querySelector('img')) {
            const firstLetter = track.name.charAt(0).toUpperCase();
            thumbDiv.innerHTML = firstLetter;
            // regenerate colour (could also keep existing)
            const hue = (track.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360);
            thumbDiv.style.background = `hsl(${hue}, 70%, 55%)`;
        }
    }
}

// ==================== REFRESH FOLDER ====================
async function refreshFolder() {
    if (!folderHandle) {
        alert('No folder selected. Please select a folder first.');
        return;
    }
    await loadTracksFromHandle(folderHandle);
}

// ==================== PLAYLIST ORDER ====================
function updatePlaylistOrder() {
    if (shuffle) {
        playlistOrder = Array.from({ length: tracks.length }, (_, i) => i);
        for (let i = playlistOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playlistOrder[i], playlistOrder[j]] = [playlistOrder[j], playlistOrder[i]];
        }
    } else {
        playlistOrder = Array.from({ length: tracks.length }, (_, i) => i);
    }
}

// ==================== RENDER TRACK LIST ====================
function renderTrackList() {
    const filter = searchInput.value.toLowerCase();
    const filtered = tracks.filter(t => t.name.toLowerCase().includes(filter));
    if (filtered.length === 0) {
        trackListContainer.innerHTML = `<div class="placeholder-message"><i class="fas fa-search"></i><p>No matching tracks</p></div>`;
        return;
    }

    let html = '';
    filtered.forEach(track => {
        const isActive = (tracks[currentTrackIndex] && tracks[currentTrackIndex].name === track.name);
        // Generate colour for fallback
        const hue = (track.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360);
        const bgColor = `hsl(${hue}, 70%, 55%)`;
        const firstLetter = track.name.charAt(0).toUpperCase();

        // If we already have a picture, use it; otherwise fallback to coloured letter
        let thumbHtml = '';
        if (track.pictureUrl) {
            thumbHtml = `<img src="${track.pictureUrl}" alt="cover">`;
        } else {
            thumbHtml = firstLetter;
        }

        html += `
            <div class="track-item ${isActive ? 'active' : ''}" data-track-id="${track.id}">
                <div class="track-thumb" style="background: ${bgColor};">${thumbHtml}</div>
                <div class="track-info">
                    <span class="track-name">${escapeHTML(track.name)}</span>
                </div>
            </div>
        `;
    });
    trackListContainer.innerHTML = html;

    // Add click listeners
    document.querySelectorAll('.track-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = parseInt(item.dataset.trackId);
            const trackIndex = tracks.findIndex(t => t.id === id);
            if (trackIndex !== -1) {
                currentTrackIndex = trackIndex;
                loadTrack(currentTrackIndex);
                audio.play();
            }
        });
    });
}

// Simple escape to prevent XSS
function escapeHTML(str) {
    return str.replace(/[&<>"]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return m;
    });
}

// ==================== LOAD TRACK ====================
async function loadTrack(index) {
    if (index < 0 || index >= tracks.length) return;
    const track = tracks[index];

    if (audio.src) URL.revokeObjectURL(audio.src);

    let file;
    if (track.fileHandle instanceof FileSystemFileHandle) {
        file = await track.fileHandle.getFile();
    } else {
        file = track.fileHandle;
    }

    const url = URL.createObjectURL(file);
    audio.src = url;
    track.url = url;

    // Update now‑playing info
    currentTrackName.textContent = track.title || track.name;
    currentTrackArtist.textContent = track.artist || 'Quran Recitation';

    // Update the large thumbnail
    if (track.pictureUrl) {
        // Remove any existing image
        let img = thumbnailDiv.querySelector('img');
        if (!img) {
            img = document.createElement('img');
            thumbnailDiv.appendChild(img);
        }
        img.src = track.pictureUrl;
        thumbnailDiv.classList.add('has-image');
    } else {
        // Hide image, show icon
        const img = thumbnailDiv.querySelector('img');
        if (img) img.remove();
        thumbnailDiv.classList.remove('has-image');
    }

    // Update active class in list
    renderTrackList();

    if (!visualizerCtx) {
        setupVisualizer();
    }
}

// ==================== PLAYBACK CONTROLS ====================
function togglePlayPause() {
    if (audio.paused) {
        audio.play();
    } else {
        audio.pause();
    }
}

function playPrevious() {
    if (tracks.length === 0) return;
    let newIndex = currentTrackIndex - 1;
    if (newIndex < 0) newIndex = tracks.length - 1;
    currentTrackIndex = newIndex;
    loadTrack(currentTrackIndex);
    audio.play();
}

function playNext() {
    if (tracks.length === 0) return;
    let newIndex = currentTrackIndex + 1;
    if (newIndex >= tracks.length) newIndex = 0;
    currentTrackIndex = newIndex;
    loadTrack(currentTrackIndex);
    audio.play();
}

function toggleShuffle() {
    shuffle = !shuffle;
    shuffleBtn.style.color = shuffle ? 'var(--accent)' : '';
    updatePlaylistOrder();
}

function toggleRepeat() {
    if (repeatMode === 'none') repeatMode = 'all';
    else if (repeatMode === 'all') repeatMode = 'one';
    else repeatMode = 'none';

    let icon = 'fa-repeat';
    if (repeatMode === 'one') icon = 'fa-repeat-1';
    repeatBtn.innerHTML = `<i class="fas ${icon}"></i>`;
    repeatBtn.style.color = repeatMode !== 'none' ? 'var(--accent)' : '';
}

function toggleMute() {
    audio.muted = !audio.muted;
    updateMuteIcon();
}

function updateMuteIcon() {
    if (audio.muted || audio.volume === 0) {
        muteBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
    } else if (audio.volume < 0.5) {
        muteBtn.innerHTML = '<i class="fas fa-volume-down"></i>';
    } else {
        muteBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
    }
}

function updatePlayPauseIcon(isPlaying) {
    playPauseBtn.innerHTML = isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
}

function seek(e) {
    const rect = progressBar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audio.currentTime = percent * audio.duration;
}

function updateProgress() {
    if (audio.duration) {
        const percent = (audio.currentTime / audio.duration) * 100;
        progressFill.style.width = percent + '%';
        currentTimeSpan.textContent = formatTime(audio.currentTime);
    }
}

function updateDuration() {
    durationSpan.textContent = formatTime(audio.duration);
}

function formatTime(sec) {
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function handleTrackEnd() {
    if (repeatMode === 'one') {
        audio.currentTime = 0;
        audio.play();
    } else {
        playNext();
    }
}

// ==================== VISUALIZER ====================
function setupVisualizer() {
    if (!audio) return;
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    visualizerAnalyser = audioCtx.createAnalyser();
    visualizerAnalyser.fftSize = 256;
    const bufferLength = visualizerAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    visualizerSource = audioCtx.createMediaElementSource(audio);
    visualizerSource.connect(visualizerAnalyser);
    visualizerAnalyser.connect(audioCtx.destination);

    const canvasCtx = visualizerCanvas.getContext('2d');
    const WIDTH = visualizerCanvas.width;
    const HEIGHT = visualizerCanvas.height;

    function draw() {
        animationFrame = requestAnimationFrame(draw);
        visualizerAnalyser.getByteFrequencyData(dataArray);
        canvasCtx.clearRect(0, 0, WIDTH, HEIGHT);
        canvasCtx.fillStyle = 'rgba(255,255,255,0.05)';
        canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

        const barWidth = (WIDTH / bufferLength) * 2.5;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = dataArray[i] / 2;
            canvasCtx.fillStyle = `rgba(100, 180, 255, 0.3)`;
            canvasCtx.fillRect(x, HEIGHT - barHeight, barWidth, barHeight);
            x += barWidth + 1;
        }
    }
    draw();
}

// ==================== FILTER TRACKS ====================
function filterTracks() {
    renderTrackList();
}

// ==================== THEME TOGGLE ====================
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const newTheme = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    themeToggle.innerHTML = newTheme === 'light' ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
}

// ==================== KEYBOARD SHORTCUTS ====================
function handleKeyboard(e) {
    if (e.target.tagName === 'INPUT') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            audio.currentTime -= 5;
            break;
        case 'ArrowRight':
            e.preventDefault();
            audio.currentTime += 5;
            break;
        case 'KeyN':
            if (e.ctrlKey) playNext();
            break;
        case 'KeyP':
            if (e.ctrlKey) playPrevious();
            break;
    }
}

// ==================== HELPER ====================
function showPlaceholder(msg) {
    trackListContainer.innerHTML = `<div class="placeholder-message"><i class="fas fa-folder-open"></i><p>${msg}</p></div>`;
}