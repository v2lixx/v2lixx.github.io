/* Research list renderer shared by category pages. */
(function () {
    'use strict';

    function escapeHTML(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function fmtDate(s) {
        return s || '';
    }

    var listEl = document.getElementById('post-list');
    if (!listEl) return;

    var category = listEl.getAttribute('data-category') || '';
    var emptyLabel = listEl.getAttribute('data-empty-label') || 'no posts yet.';

    fetch('posts/index.json', { cache: 'no-cache' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(function (posts) {
            if (!Array.isArray(posts)) posts = [];

            posts = posts.filter(function (p) {
                var postCategory = p.category || '0-day';
                return !category || postCategory === category;
            });

            if (posts.length === 0) {
                listEl.innerHTML = '<li class="post-empty">' + escapeHTML(emptyLabel) + '</li>';
                return;
            }

            posts.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

            var html = posts.map(function (p) {
                var vendorChip = p.vendor ? '<span class="post-vendor">' + escapeHTML(p.vendor) + '</span>' : '';
                return (
                    '<li>' +
                        '<div class="post-when">' + escapeHTML(fmtDate(p.date)) + '</div>' +
                        '<div class="post-body">' +
                            '<a class="post-link" href="post.html?id=' + encodeURIComponent(p.slug) + '">' + escapeHTML(p.title) + '</a>' +
                            '<div class="post-meta-row">' + vendorChip + '</div>' +
                        '</div>' +
                    '</li>'
                );
            }).join('');
            listEl.innerHTML = html;
        })
        .catch(function (err) {
            listEl.innerHTML = '<li class="post-empty">failed to load posts: ' + escapeHTML(err.message) + '</li>';
        });
})();
