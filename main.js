/* Seung Min Shin · portfolio
 * - theme toggle (dark / light), persisted
 * - CRT scanline toggle, persisted
 * - typewriter on the hero command
 * - active-section highlight in the nav
 */

(function () {
    'use strict';

    const root = document.documentElement;

    /* ----- theme toggle -------------------------------------- */
    const themeBtn = document.getElementById('theme-toggle');

    function setTheme(t) {
        root.setAttribute('data-theme', t);
        try { localStorage.setItem('theme', t); } catch (e) {}
        if (themeBtn) themeBtn.textContent = t;
    }
    if (themeBtn) {
        themeBtn.textContent = root.getAttribute('data-theme') || 'dark';
        themeBtn.addEventListener('click', function () {
            const cur = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
            setTheme(cur === 'light' ? 'dark' : 'light');
        });
    }

    /* ----- CRT scanline toggle ------------------------------- */
    const crtBtn = document.getElementById('crt-toggle');

    function setCrt(state) {
        if (state === 'on') root.setAttribute('data-crt', 'on');
        else root.removeAttribute('data-crt');
        try { localStorage.setItem('crt', state); } catch (e) {}
        if (crtBtn) crtBtn.style.color = state === 'on' ? 'var(--accent)' : '';
    }
    if (crtBtn) {
        crtBtn.addEventListener('click', function () {
            const cur = root.getAttribute('data-crt') === 'on' ? 'on' : 'off';
            setCrt(cur === 'on' ? 'off' : 'on');
        });
        if (root.getAttribute('data-crt') === 'on') {
            crtBtn.style.color = 'var(--accent)';
        }
    }

    /* ----- typewriter on the hero command -------------------- */
    const cmdEl = document.querySelector('.terminal-prompt .prompt-cmd');
    if (cmdEl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const text = cmdEl.textContent;
        cmdEl.textContent = '';
        let i = 0;
        const tick = function () {
            cmdEl.textContent = text.slice(0, i);
            i += 1;
            if (i <= text.length) {
                setTimeout(tick, 70 + Math.random() * 50);
            }
        };
        setTimeout(tick, 350);
    }

    /* ----- active section in nav ----------------------------- */
    const sections = Array.prototype.slice.call(
        document.querySelectorAll('section[id], header[id]')
    );
    const navLinks = Array.prototype.slice.call(
        document.querySelectorAll('.nav-links a[href^="#"]')
    );

    if ('IntersectionObserver' in window && sections.length && navLinks.length) {
        const byId = {};
        navLinks.forEach(function (a) {
            const id = a.getAttribute('href').slice(1);
            byId[id] = a;
        });

        const obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                const id = e.target.getAttribute('id');
                const link = byId[id];
                if (!link) return;
                if (e.isIntersecting && e.intersectionRatio > 0.4) {
                    navLinks.forEach(function (a) { a.style.color = ''; });
                    link.style.color = 'var(--fg-strong)';
                }
            });
        }, { threshold: [0.4, 0.6] });

        sections.forEach(function (s) { obs.observe(s); });
    }

    /* ----- avatar shimmer on click (small easter egg) -------- */
    const avatar = document.querySelector('.avatar');
    if (avatar) {
        avatar.addEventListener('click', function () {
            avatar.animate(
                [
                    { filter: 'hue-rotate(0deg)' },
                    { filter: 'hue-rotate(180deg)' },
                    { filter: 'hue-rotate(360deg)' }
                ],
                { duration: 700, easing: 'ease-in-out' }
            );
        });
    }
})();
