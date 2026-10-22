/* Campus vector guide on MapLibre GL JS. No remote basemap, glyph, or sprite sources. */
(function () {
    'use strict';

    const DEFAULT_CENTER = [116.1106, 39.8100];
    const CAMPUS_BOUNDS = [[116.10310136576231, 39.80568409255671], [116.11805609538932, 39.8142909422097]];
    const CATEGORY_COLORS = {
        '教学科研': { fill: '#6688a8', stroke: '#45647f' },
        '住宿生活': { fill: '#df8b77', stroke: '#a85d4b' },
        '餐饮': { fill: '#75a879', stroke: '#4c7951' },
        '公共文化': { fill: '#d0ae58', stroke: '#967b36' },
        '医疗服务': { fill: '#59a8a1', stroke: '#397d77' },
        '商业服务': { fill: '#ad82aa', stroke: '#7a5878' },
        '校园设施': { fill: '#93a1a8', stroke: '#65747c' },
        '出入口安保': { fill: '#c9844f', stroke: '#925c32' },
        '体育场地': { fill: '#4eae5b', stroke: '#27703d' },
        '综合/待核': { fill: '#a6a09a', stroke: '#736d68' },
        '附属/待核': { fill: '#b8ad89', stroke: '#847a5c' }
    };
    const GROUP_LAYERS = {
        green: ['green-fill', 'green-line'],
        roads: ['roads-fill', 'roads-line'],
        sports: ['sports-fill', 'sports-pattern', 'sports-line'],
        buildings: ['buildings-fill', 'buildings-sports-pattern', 'buildings-line'],
        boundary: ['boundary-line']
    };
    const state = {
        selectedBuildingId: null,
        hiddenCategories: new Set(),
        visibleLayers: { green: true, roads: true, sports: true, buildings: true, boundary: true },
        namesVisible: true
    };
    const ui = {
        panel: document.querySelector('.campus-name-control'),
        toggle: document.getElementById('campus-panel-toggle'),
        body: document.getElementById('campus-panel-body'),
        select: document.getElementById('campus-building-select'),
        status: document.getElementById('campus-selection-status'),
        clear: document.getElementById('campus-clear-selection'),
        names: document.getElementById('campus-name-toggle'),
        legend: document.getElementById('campus-category-legend'),
        loading: document.getElementById('map-status'),
        error: document.getElementById('map-error')
    };
    let map;
    let popup = null;
    let popupFeature = null;
    let hovered = null;
    let initialized = false;
    let resolveReady;
    let rejectReady;
    let measureToggle;
    const errors = [];
    const labelMarkers = [];
    const gateMarkers = [];
    const categoryInputs = new Map();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ready = new Promise(function (resolve, reject) { resolveReady = resolve; rejectReady = reject; });
    // The public promise remains rejectable for callers without producing an unhandled rejection.
    ready.catch(function () {});

    function showError(error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        ui.loading.hidden = true;
        ui.error.hidden = false;
        ui.error.textContent = '校园地图暂时无法加载。请确认浏览器已启用 WebGL / 硬件加速，或尝试更新浏览器。' + '（' + message + '）';
        rejectReady(error instanceof Error ? error : new Error(message));
    }

    function shade(hex, amount) {
        const value = parseInt(hex.slice(1), 16);
        const channel = function (shift) { return Math.round(((value >> shift) & 255) * (1 - amount)); };
        return '#' + [channel(16), channel(8), channel(0)].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
    }

    function sportsSurface(properties) {
        const name = properties.name || '';
        if (name === '田径场') return { fill: '#c77963', stroke: '#8d4c3b', pattern: 'sports-track' };
        if (/篮球|排球|网球/.test(name)) return { fill: '#76bfc9', stroke: '#337784', pattern: 'sports-court' };
        if (name === '气膜馆') return { fill: '#b8cddc', stroke: '#5c7c94', pattern: '' };
        return { fill: '#4eae5b', stroke: '#27703d', pattern: 'sports-turf' };
    }

    function buildingSurface(properties) {
        const name = properties.name || '';
        if (name.indexOf('北门') !== -1) return { fill: '#4c9dc7', stroke: '#1e6488', pattern: '' };
        if (name.indexOf('南门') !== -1) return { fill: '#e8784c', stroke: '#9c4125', pattern: '' };
        if (properties.category === '体育场地') return sportsSurface(properties);
        return Object.assign({ pattern: '' }, CATEGORY_COLORS[properties.category] || CATEGORY_COLORS['综合/待核']);
    }

    function prepare(raw, group) {
        const collection = JSON.parse(JSON.stringify(raw));
        collection.features.forEach(function (feature, index) {
            const p = feature.properties || (feature.properties = {});
            p.fid = String(p.fid == null ? index + 1 : p.fid);
            feature.id = p.fid;
            if (group === 'buildings' || group === 'sports') {
                if (group === 'buildings') p.category = p.category || '综合/待核';
                const colors = group === 'sports' ? sportsSurface(p) : buildingSurface(p);
                const gate = /北门|南门/.test(p.name || '');
                Object.assign(p, {
                    _fill: colors.fill,
                    _selectedFill: shade(colors.fill, 0.22),
                    _stroke: colors.stroke,
                    _hoverStroke: shade(colors.stroke, 0.12),
                    _pattern: colors.pattern,
                    _selectedPattern: colors.pattern ? colors.pattern + '-selected' : '',
                    _width: gate ? 1.8 : group === 'sports' ? 1.3 : 1.1,
                    _opacity: gate || group === 'sports' || p.category === '体育场地' ? 0.98 : 0.88,
                    _order: p.name === '田径场' ? 0 : p.name === '田径场内场' ? 1 : 2
                });
            }
        });
        return collection;
    }

    const data = {
        green: prepare(window.json__1, 'green'),
        roads: prepare(window.json__2, 'roads'),
        sports: prepare(window.json__3, 'sports'),
        buildings: prepare(window.json__4, 'buildings'),
        boundary: prepare(window.json__5, 'boundary')
    };
    const buildingById = new Map(data.buildings.features.map(function (feature) { return [feature.id, feature]; }));
    const gateCenters = new Map();

    function coordinates(geometry) {
        const points = [];
        function walk(value) {
            if (!Array.isArray(value)) return;
            if (typeof value[0] === 'number') { points.push(value); return; }
            value.forEach(walk);
        }
        walk(geometry.coordinates);
        return points;
    }

    function featureBounds(feature) {
        const points = coordinates(feature.geometry);
        const bounds = new maplibregl.LngLatBounds();
        points.forEach(function (point) { bounds.extend(point); });
        return bounds;
    }

    function featureCenter(feature) {
        // Area-weighted outer-ring centroid, adequate for this small campus extent.
        let ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates[0][0] : null;
        if (ring && ring.length >= 3) {
            const origin = ring[0];
            let twiceArea = 0;
            let x = 0;
            let y = 0;
            for (let i = 0; i < ring.length - 1; i += 1) {
                const a = [ring[i][0] - origin[0], ring[i][1] - origin[1]];
                const b = [ring[i + 1][0] - origin[0], ring[i + 1][1] - origin[1]];
                const cross = a[0] * b[1] - b[0] * a[1];
                twiceArea += cross;
                x += (a[0] + b[0]) * cross;
                y += (a[1] + b[1]) * cross;
            }
            if (Math.abs(twiceArea) > 1e-15) return [origin[0] + x / (3 * twiceArea), origin[1] + y / (3 * twiceArea)];
        }
        return featureBounds(feature).getCenter().toArray();
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = String(text);
        return node;
    }

    function makeCard(properties, isBuilding) {
        const card = element('article', 'campus-card');
        const head = element('div', 'campus-card-head');
        const icon = element('span', 'campus-card-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>';
        const title = element('div', 'campus-card-title');
        title.appendChild(element('h2', '', properties.name || (isBuilding ? '未命名建筑' : '运动场地')));
        title.appendChild(element('p', 'campus-card-sub', '丰台校区 · ' + (isBuilding ? properties.category : '体育场地')));
        head.append(icon, title);
        card.appendChild(head);
        if (isBuilding && properties.floor) card.appendChild(element('p', 'campus-card-desc', '楼层信息：' + properties.floor + ' 层'));
        const tags = element('div', 'campus-card-tags');
        [isBuilding ? properties.category : '体育场地', '编号 #' + properties.fid].forEach(function (text) { if (text) tags.appendChild(element('span', 'campus-card-tag', text)); });
        card.appendChild(tags);
        const metadata = [['名称状态', properties.name_status], ['名称来源', properties.name_source], ['核对说明', properties.name_note]].filter(function (row) { return row[1]; });
        if (isBuilding && metadata.length) {
            const details = element('details', 'campus-card-meta');
            details.appendChild(element('summary', '', '名称来源与核对说明'));
            metadata.forEach(function (row) {
                const paragraph = element('p');
                paragraph.append(element('strong', '', row[0] + '：'), document.createTextNode(String(row[1])));
                details.appendChild(paragraph);
            });
            details.addEventListener('toggle', function () { if (popup && popup.getElement().contains(card)) popup.setDOMContent(card); });
            card.appendChild(details);
        }
        return card;
    }

    function closePopup() {
        if (popup) { popup.remove(); popup = null; }
        popupFeature = null;
    }

    function openCard(feature, group, at) {
        closePopup();
        popupFeature = { group: group, id: feature.id };
        popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'campus-place-card', maxWidth: '320px', offset: 12, focusAfterOpen: false })
            .setLngLat(at || featureCenter(feature))
            .setDOMContent(makeCard(feature.properties, group === 'buildings'))
            .addTo(map);
        const active = popup;
        active.on('close', function () { if (popup === active) { popup = null; popupFeature = null; } });
    }

    function createPatterns() {
        function register(id, draw) {
            const canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
            const context = canvas.getContext('2d');
            draw(context);
            map.addImage(id, context.getImageData(0, 0, 16, 16));
        }
        register('sports-turf', function (context) {
            context.fillStyle = '#4eae5b'; context.fillRect(0, 0, 16, 16);
            context.fillStyle = '#d9f2bf'; context.fillRect(0, 0, 16, 2);
        });
        register('sports-court', function (context) {
            context.fillStyle = '#76bfc9'; context.fillRect(0, 0, 16, 16);
            context.strokeStyle = '#d4edf0'; context.globalAlpha = 0.65; context.lineWidth = 0.8;
            context.beginPath(); context.moveTo(-8, 8); context.lineTo(8, 24); context.moveTo(0, 0); context.lineTo(16, 16); context.moveTo(8, -8); context.lineTo(24, 8); context.stroke();
        });
        register('sports-track', function (context) {
            context.fillStyle = '#c77963'; context.fillRect(0, 0, 16, 16);
            context.fillStyle = '#f4d5c8'; context.fillRect(0, 0, 16, 1);
        });
        [['sports-turf', '#4eae5b'], ['sports-court', '#76bfc9'], ['sports-track', '#c77963']].forEach(function (surface) {
            register(surface[0] + '-selected', function (context) { context.fillStyle = shade(surface[1], 0.22); context.fillRect(0, 0, 16, 16); });
        });
    }

    function addLayers() {
        Object.keys(data).forEach(function (id) { map.addSource(id, { type: 'geojson', data: data[id] }); });
        map.addLayer({ id: 'green-fill', type: 'fill', source: 'green', paint: { 'fill-color': '#E1F2D6', 'fill-opacity': 1 } });
        map.addLayer({ id: 'green-line', type: 'line', source: 'green', paint: { 'line-color': 'rgba(156,181,137,0.65)', 'line-width': 0.6 } });
        map.addLayer({ id: 'roads-fill', type: 'fill', source: 'roads', paint: { 'fill-color': '#d3d8d4', 'fill-opacity': 0.96 } });
        map.addLayer({ id: 'roads-line', type: 'line', source: 'roads', paint: { 'line-color': 'rgba(117,130,122,0.88)', 'line-width': 0.9 } });
        map.addLayer({ id: 'sports-fill', type: 'fill', source: 'sports', paint: { 'fill-color': ['get', '_fill'], 'fill-opacity': 0.98 } });
        map.addLayer({ id: 'sports-pattern', type: 'fill', source: 'sports', filter: ['!=', ['get', '_pattern'], ''], paint: { 'fill-pattern': ['get', '_pattern'], 'fill-opacity': 0.98, 'fill-pattern-transition': { duration: 0, delay: 0 }, 'fill-opacity-transition': { duration: 0, delay: 0 } } });
        map.addLayer({ id: 'sports-line', type: 'line', source: 'sports', paint: {
            'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], ['get', '_hoverStroke'], ['get', '_stroke']],
            'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.2, 1.3]
        } });
        map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', layout: { 'fill-sort-key': ['get', '_order'] }, paint: {
            'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], ['get', '_selectedFill'], ['get', '_fill']],
            'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, ['boolean', ['feature-state', 'hover'], false], 0.98, ['get', '_opacity']]
        } });
        map.addLayer({ id: 'buildings-sports-pattern', type: 'fill', source: 'buildings', layout: { 'fill-sort-key': ['get', '_order'] }, filter: ['!=', ['get', '_pattern'], ''], paint: { 'fill-pattern': ['get', '_pattern'], 'fill-opacity': 0.98, 'fill-pattern-transition': { duration: 0, delay: 0 }, 'fill-opacity-transition': { duration: 0, delay: 0 } } });
        map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings', layout: { 'line-sort-key': ['get', '_order'] }, paint: {
            'line-color': ['case', ['all', ['boolean', ['feature-state', 'hover'], false], ['!', ['boolean', ['feature-state', 'selected'], false]]], ['get', '_hoverStroke'], ['get', '_stroke']],
            'line-width': ['case', ['all', ['boolean', ['feature-state', 'hover'], false], ['!', ['boolean', ['feature-state', 'selected'], false]]], 2, ['get', '_width']]
        } });
        map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': 'rgba(102,116,108,0.58)', 'line-width': 1.5 } });
    }

    function categoryVisible(feature) { return !state.hiddenCategories.has(feature.properties.category); }
    function buildingVisible(feature) { return state.visibleLayers.buildings && categoryVisible(feature) && (feature.properties.category !== '体育场地' || state.visibleLayers.sports); }
    function sportsVisible() { return state.visibleLayers.sports && !state.hiddenCategories.has('体育场地'); }

    function updateFilters() {
        if (!initialized) return;
        Object.keys(GROUP_LAYERS).forEach(function (group) {
            const visible = group === 'sports' ? sportsVisible() : state.visibleLayers[group];
            GROUP_LAYERS[group].forEach(function (id) { map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); });
        });
        const filter = ['all', ['!', ['in', ['get', 'category'], ['literal', Array.from(state.hiddenCategories)]]]];
        if (!state.visibleLayers.sports) filter.push(['!=', ['get', 'category'], '体育场地']);
        map.setFilter('buildings-fill', filter);
        map.setFilter('buildings-line', filter);
        map.setFilter('buildings-sports-pattern', ['all', filter, ['!=', ['get', '_pattern'], '']]);
        syncSelectionPattern();
        for (const option of ui.select.options) {
            if (option.value) option.disabled = !buildingVisible(buildingById.get(option.value));
        }
        if (state.selectedBuildingId && !buildingVisible(buildingById.get(state.selectedBuildingId))) clearSelection();
        if (popupFeature && (popupFeature.group === 'sports' ? !sportsVisible() : !buildingVisible(buildingById.get(popupFeature.id)))) closePopup();
        refreshNames();
        clearHover();
    }

    function createNames() {
        const major = new Set(['5', '6', '23', '40', '41', '47', '48', '49', '50', '51', '52', '53', '56', '59', '63']);
        const small = new Set(['42', '43', '44', '45', '46', '54', '57', '58', '60', '61']);
        const reviewed = new Set(['52', '53', '54', '56']);
        data.buildings.features.forEach(function (feature) {
            const p = feature.properties;
            if (!p.name || /南门|北门/.test(p.name)) return;
            const label = element('span', 'campus-building-label', p.name.replace(/\+/g, ' · ') + (reviewed.has(feature.id) ? ' †' : ''));
            label.setAttribute('data-building-label', feature.id);
            label.setAttribute('aria-hidden', 'true');
            const marker = new maplibregl.Marker({ element: label }).setLngLat(featureCenter(feature)).addTo(map);
            labelMarkers.push({ marker: marker, feature: feature, minZoom: major.has(feature.id) ? 17 : small.has(feature.id) ? 19 : 18 });
        });
        ['北门', '南门'].forEach(function (name) {
            const features = data.buildings.features.filter(function (feature) { return (feature.properties.name || '').indexOf(name) !== -1; });
            if (!features.length) return;
            const bounds = new maplibregl.LngLatBounds();
            features.forEach(function (feature) { bounds.extend(featureBounds(feature)); });
            const center = bounds.getCenter().toArray();
            features.forEach(function (feature) { gateCenters.set(feature.id, center); });
            const isNorth = name === '北门';
            const button = element('button', 'campus-gate-marker');
            button.type = 'button';
            button.dataset.gate = isNorth ? 'north' : 'south';
            button.setAttribute('aria-label', name + '：查看门卫详情');
            button.title = name + '：查看门卫详情';
            const arrow = element('span', 'campus-gate-arrow', isNorth ? '↑' : '↓');
            arrow.setAttribute('aria-hidden', 'true');
            button.append(arrow, document.createTextNode(name));
            button.addEventListener('click', function (event) { event.stopPropagation(); if (!measurement.mode) selectBuilding(features[0].id, { moveTo: false }); });
            const marker = new maplibregl.Marker({ element: button, anchor: 'bottom' }).setLngLat(center).addTo(map);
            gateMarkers.push({ marker: marker, features: features, center: center });
        });
    }

    function refreshNames() {
        if (!initialized) return;
        const zoom = map.getZoom();
        labelMarkers.forEach(function (entry) { entry.marker.getElement().hidden = !state.namesVisible || zoom < entry.minZoom || !buildingVisible(entry.feature); });
        gateMarkers.forEach(function (entry) { entry.marker.getElement().hidden = !state.namesVisible || zoom < 15 || !entry.features.some(buildingVisible); });
    }

    function setNamesVisible(visible) { state.namesVisible = Boolean(visible); ui.names.checked = state.namesVisible; refreshNames(); }
    function setLayerVisible(group, visible) {
        if (!Object.prototype.hasOwnProperty.call(state.visibleLayers, group)) return false;
        state.visibleLayers[group] = Boolean(visible);
        const input = document.querySelector('[data-layer="' + group + '"]');
        if (input) input.checked = Boolean(visible);
        updateFilters();
        return true;
    }
    function setCategoryVisible(category, visible) {
        if (visible) state.hiddenCategories.delete(category); else state.hiddenCategories.add(category);
        if (categoryInputs.has(category)) categoryInputs.get(category).checked = Boolean(visible);
        updateFilters();
    }

    function clearHover() {
        if (hovered && map && initialized) map.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: false });
        hovered = null;
        if (map) map.getCanvas().style.cursor = measurement.mode ? 'crosshair' : '';
    }

    function syncSelectionPattern() {
        if (!initialized) return;
        const selected = state.selectedBuildingId;
        map.setPaintProperty('buildings-sports-pattern', 'fill-pattern', selected ? ['case', ['==', ['get', 'fid'], selected], ['get', '_selectedPattern'], ['get', '_pattern']] : ['get', '_pattern']);
        map.setPaintProperty('buildings-sports-pattern', 'fill-opacity', selected ? ['case', ['==', ['get', 'fid'], selected], 1, 0.98] : 0.98);
    }

    function clearSelection() {
        if (state.selectedBuildingId && initialized) map.setFeatureState({ source: 'buildings', id: state.selectedBuildingId }, { selected: false });
        state.selectedBuildingId = null;
        closePopup();
        ui.select.value = '';
        ui.status.textContent = '点选地图上的建筑，或从列表定位';
        ui.clear.disabled = true;
        syncSelectionPattern();
    }

    function selectBuilding(fid, options) {
        const feature = buildingById.get(String(fid));
        if (!initialized || !feature || !buildingVisible(feature)) return false;
        clearSelection();
        state.selectedBuildingId = feature.id;
        map.setFeatureState({ source: 'buildings', id: feature.id }, { selected: true });
        syncSelectionPattern();
        ui.select.value = feature.id;
        ui.status.textContent = (feature.properties.name || '未命名建筑') + ' · ' + feature.properties.category;
        ui.clear.disabled = false;
        if (options && options.moveTo) {
            map.fitBounds(featureBounds(feature), { padding: Math.min(100, Math.max(45, map.getContainer().clientWidth * 0.15)), maxZoom: 18, duration: reducedMotion ? 0 : 450 });
        }
        openCard(feature, 'buildings', gateCenters.get(feature.id));
        return true;
    }

    function fitCampus() {
        map.fitBounds(CAMPUS_BOUNDS, { padding: { top: 85, left: 40, right: 40, bottom: 80 }, maxZoom: 17, duration: reducedMotion ? 0 : 450 });
    }

    function buildGuide() {
        const grouped = new Map();
        data.buildings.features.forEach(function (feature) {
            const category = feature.properties.category;
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(feature);
        });
        Array.from(grouped.keys()).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }).forEach(function (category) {
            const features = grouped.get(category);
            const group = element('optgroup'); group.label = category;
            features.sort(function (a, b) { return (a.properties.name || '').localeCompare(b.properties.name || '', 'zh-CN') || Number(a.id) - Number(b.id); }).forEach(function (feature) {
                const option = element('option', '', (feature.properties.name || '未命名建筑').replace(/\+/g, ' · ') + ' · #' + feature.id);
                option.value = feature.id; group.appendChild(option);
            });
            ui.select.appendChild(group);
            const label = element('label', 'campus-legend-item');
            const input = element('input'); input.type = 'checkbox'; input.checked = true; input.dataset.campusCategory = category; input.setAttribute('aria-label', '显示' + category);
            input.addEventListener('change', function () { setCategoryVisible(category, input.checked); });
            categoryInputs.set(category, input);
            const swatch = element('i', 'campus-map-swatch'); swatch.setAttribute('aria-hidden', 'true');
            if (category === '体育场地') swatch.classList.add('campus-map-swatch-sports');
            else if (category === '出入口安保') swatch.classList.add('campus-map-swatch-gates');
            else swatch.style.backgroundColor = (CATEGORY_COLORS[category] || CATEGORY_COLORS['综合/待核']).fill;
            let count = features.length;
            if (category === '体育场地') count = new Set(features.concat(data.sports.features).map(function (feature) { return JSON.stringify(feature.geometry.coordinates); })).size;
            label.append(input, swatch, document.createTextNode(category + ' (' + count + ')'));
            ui.legend.appendChild(label);
        });
        ui.select.disabled = false;
    }

    function hitAt(point) {
        const features = map.queryRenderedFeatures(point, { layers: ['buildings-fill', 'sports-fill'] });
        const building = features.find(function (feature) { return feature.source === 'buildings'; });
        return building || features[0] || null;
    }

    function bindMapInteraction() {
        map.on('click', function (event) {
            if (measurement.mode) { addMeasurePoint([event.lngLat.lng, event.lngLat.lat]); return; }
            const hit = hitAt(event.point);
            if (hit && hit.source === 'buildings') { selectBuilding(hit.properties.fid, { moveTo: false }); return; }
            clearSelection();
            if (hit && hit.source === 'sports') {
                const feature = data.sports.features.find(function (feature) { return feature.id === String(hit.properties.fid); });
                if (feature) openCard(feature, 'sports', event.lngLat);
            }
        });
        map.on('mousemove', function (event) {
            if (measurement.mode) return;
            const hit = hitAt(event.point);
            if (!hit) { clearHover(); return; }
            if (!hovered || hovered.source !== hit.source || hovered.id !== String(hit.id)) {
                clearHover();
                hovered = { source: hit.source, id: String(hit.id) };
                map.setFeatureState(hovered, { hover: true });
            }
            map.getCanvas().style.cursor = 'pointer';
        });
        map.getCanvas().addEventListener('mouseleave', clearHover);
        map.on('zoomend', refreshNames);
    }

    const measurement = { mode: null, points: [] };
    const EARTH_RADIUS = 6371008.8;
    function distance(a, b) {
        const rad = Math.PI / 180;
        const dLat = (b[1] - a[1]) * rad;
        const dLng = (b[0] - a[0]) * rad;
        const sin = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(sin)));
    }
    function measureResult() {
        let length = 0;
        for (let i = 1; i < measurement.points.length; i += 1) length += distance(measurement.points[i - 1], measurement.points[i]);
        let area = 0;
        if (measurement.mode === 'area' && measurement.points.length >= 3) {
            const rad = Math.PI / 180;
            for (let i = 0; i < measurement.points.length; i += 1) {
                const a = measurement.points[i]; const b = measurement.points[(i + 1) % measurement.points.length];
                area += (b[0] - a[0]) * rad * (2 + Math.sin(a[1] * rad) + Math.sin(b[1] * rad));
            }
            area = Math.abs(area * EARTH_RADIUS * EARTH_RADIUS / 2);
        }
        return { mode: measurement.mode, points: measurement.points.map(function (point) { return point.slice(); }), lengthMeters: length, areaSquareMeters: area };
    }
    function updateMeasurement() {
        const features = measurement.points.map(function (point) { return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point } }; });
        if (measurement.points.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: measurement.points } });
        if (measurement.mode === 'area' && measurement.points.length >= 3) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [measurement.points.concat([measurement.points[0]])] } });
        if (map.getSource('measurement')) map.getSource('measurement').setData({ type: 'FeatureCollection', features: features });
        const result = measureResult();
        const text = measurement.mode === 'area' ? result.areaSquareMeters >= 1000000 ? (result.areaSquareMeters / 1000000).toFixed(3) + ' 平方千米' : result.areaSquareMeters.toFixed(1) + ' 平方米' : result.lengthMeters >= 1000 ? (result.lengthMeters / 1000).toFixed(2) + ' 千米' : result.lengthMeters.toFixed(1) + ' 米';
        document.getElementById('measure-result').textContent = measurement.points.length ? text + ' · 已选 ' + measurement.points.length + ' 个点，继续点选可更新。' : '在地图上依次点选' + (measurement.mode === 'area' ? '至少三个点测面积。' : '至少两个点测距离。');
    }
    function startMeasurement(mode) {
        if (!initialized || !['distance', 'area'].includes(mode)) return false;
        clearSelection(); clearHover();
        measurement.mode = mode; measurement.points = [];
        if (!map.getSource('measurement')) {
            map.addSource('measurement', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({ id: 'measurement-area', type: 'fill', source: 'measurement', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#386e59', 'fill-opacity': 0.18 } });
            map.addLayer({ id: 'measurement-line', type: 'line', source: 'measurement', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#275e4b', 'line-width': 2, 'line-dasharray': [3, 2] } });
            map.addLayer({ id: 'measurement-points', type: 'circle', source: 'measurement', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#275e4b', 'circle-stroke-width': 2 } });
        }
        map.doubleClickZoom.disable();
        map.getCanvas().style.cursor = 'crosshair';
        document.getElementById('measure-panel').hidden = false;
        document.getElementById('measure-distance').setAttribute('aria-pressed', String(mode === 'distance'));
        document.getElementById('measure-area').setAttribute('aria-pressed', String(mode === 'area'));
        if (measureToggle) measureToggle.setAttribute('aria-pressed', 'true');
        updateMeasurement();
        return true;
    }
    function addMeasurePoint(point) {
        if (!measurement.mode || !Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)) return false;
        measurement.points.push(point.slice(0, 2)); updateMeasurement(); return true;
    }
    function stopMeasurement() {
        measurement.mode = null; measurement.points = [];
        document.getElementById('measure-panel').hidden = true;
        if (measureToggle) measureToggle.setAttribute('aria-pressed', 'false');
        if (initialized) {
            ['measurement-points', 'measurement-line', 'measurement-area'].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
            if (map.getSource('measurement')) map.removeSource('measurement');
            map.doubleClickZoom.enable(); map.getCanvas().style.cursor = '';
        }
    }

    class CampusTools {
        onAdd(currentMap) {
            this.container = element('div', 'maplibregl-ctrl maplibregl-ctrl-group campus-tool-control');
            const home = element('button'); home.type = 'button'; home.title = '回到校园全景'; home.setAttribute('aria-label', home.title);
            home.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 10 12 3l8 7v10H4Z"/><path d="M9 20v-7h6v7"/></svg>';
            home.addEventListener('click', fitCampus);
            measureToggle = element('button'); measureToggle.type = 'button'; measureToggle.title = '测距离或面积'; measureToggle.setAttribute('aria-label', measureToggle.title); measureToggle.setAttribute('aria-pressed', 'false');
            measureToggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m3 15 12-12 6 6L9 21Z"/><path d="m12 6 3 3m-6 0 2 2m-5 1 3 3"/></svg>';
            measureToggle.addEventListener('click', function () { if (measurement.mode) stopMeasurement(); else startMeasurement('distance'); });
            this.container.append(home, measureToggle);
            return this.container;
        }
        onRemove() { this.container.remove(); }
    }

    ui.toggle.addEventListener('click', function () {
        const expanded = ui.body.hidden;
        ui.body.hidden = !expanded;
        ui.toggle.setAttribute('aria-expanded', String(expanded));
        ui.panel.classList.toggle('is-collapsed', !expanded);
    });
    ui.names.addEventListener('change', function () { setNamesVisible(ui.names.checked); });
    ui.clear.addEventListener('click', clearSelection);
    ui.select.addEventListener('change', function () { if (ui.select.value) selectBuilding(ui.select.value, { moveTo: true }); else clearSelection(); });
    document.querySelectorAll('[data-layer]').forEach(function (input) { input.addEventListener('change', function () { setLayerVisible(input.dataset.layer, input.checked); }); });
    document.getElementById('measure-distance').addEventListener('click', function () { startMeasurement('distance'); });
    document.getElementById('measure-area').addEventListener('click', function () { startMeasurement('area'); });
    document.getElementById('measure-close').addEventListener('click', stopMeasurement);
    document.getElementById('measure-clear').addEventListener('click', function () { measurement.points = []; updateMeasurement(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { if (measurement.mode) stopMeasurement(); else clearSelection(); } });

    const api = {
        map: null, ready: ready, data: data, state: state, errors: errors,
        selectBuilding: selectBuilding, clearSelection: clearSelection,
        setCategoryVisible: setCategoryVisible, setLayerVisible: setLayerVisible,
        setNamesVisible: setNamesVisible, fitCampus: fitCampus,
        measurement: { start: startMeasurement, stop: stopMeasurement, clear: function () { measurement.points = []; updateMeasurement(); }, addPoint: addMeasurePoint, getResult: measureResult },
        get popup() { return popup; }
    };
    window.campusMap = api;

    try {
        if (!window.maplibregl) throw new Error('MapLibre GL JS 运行库未能加载');
        const originalHash = window.location.hash;
        const hasHash = /^#\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?(?:\/.*)?$/.test(originalHash);
        map = new maplibregl.Map({
            container: 'map',
            style: { version: 8, sources: {}, layers: [{ id: 'campus-background', type: 'background', paint: { 'background-color': '#edf1ed' } }] },
            center: DEFAULT_CENTER,
            zoom: 16,
            minZoom: 14,
            maxZoom: 20,
            maxBounds: [[116.095, 39.798], [116.126, 39.823]],
            hash: true,
            attributionControl: false,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            maxPitch: 0
        });
        api.map = map;
        map.touchZoomRotate.disableRotation();
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
        map.addControl(new CampusTools(), 'top-left');
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
        map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '校园矢量数据 · <a href="building-name-review.html" target="_blank" rel="noopener">名称来源</a>' }), 'bottom-right');
        map.on('error', function (event) { showError(event.error || new Error('地图渲染失败')); });
        map.once('load', function () {
            try {
                createPatterns();
                addLayers();
                initialized = true;
                buildGuide();
                createNames();
                updateFilters();
                bindMapInteraction();
                if (!hasHash) map.fitBounds(CAMPUS_BOUNDS, { padding: { top: 85, left: 40, right: 40, bottom: 80 }, maxZoom: 17, duration: 0 });
                map.once('idle', function () { ui.loading.hidden = true; resolveReady(api); });
            } catch (error) { showError(error); }
        });
    } catch (error) { showError(error); }
})();
