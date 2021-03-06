(function (definition, context) {
    var theModule = definition(context),
        hasDefine = typeof define === 'function' && define.amd;

    if (hasDefine) {
        define('videojs-vast-plugin', ['videojs', 'vast-client-js', 'videojs-contrib-ads'], theModule);
    } else {
        theModule(window.videojs, window.DMVAST);
    }
})(function (context) {
    return function (vjs, vast) {
        'use strict';

        var extend = function (obj) {
            var arg, i, k;
            for (i = 1; i < arguments.length; i++) {
                arg = arguments[i];
                for (k in arg) {
                    if (arg.hasOwnProperty(k)) {
                        obj[k] = arg[k];
                    }
                }
            }
            return obj;
        };

        var defaults = {
            // seconds before skip button shows, negative values to disable skip button altogether
            skip: undefined,
            suspend: false
        };

        var Vast = function (player, settings) {
            var state = {
                idle: false,
                loading: false,
                playing: false,
                error: false,
                dispose: false
            };

            var isActive = function () {
                    return !settings.suspend && !!settings.url;
                },
                checkLoad = function () {
                    if (isActive()) {
                        player.trigger('adsready');
                    }
                };

            checkLoad();

            player.on('vast-error', function () {
                if (state.loading) {
                    state.loading = false;
                    player.trigger('adscanceled');
                }
            });

            player.on('vast-ready', function () {
                // vast is prepared with content, set up ads and trigger ready function
                if (state.loading) {
                    state.loading = false;
                    player.vast.checkPlay();
                }
            });

            player.on('vast-preroll-ready', function () {
                // start playing preroll, note: this should happen this way no matter what, even if autoplay
                //  has been disabled since the preroll function shouldn't run until the user/autoplay has
                //  caused the main video to trigger this preroll function
                state.playing = true;
                player.play();
            });

            player.on('vast-preroll-removed', function () {
                // preroll done or removed, start playing the actual video
                if (!state.dispose) {
                    player.play();
                }

                state.playing = false;
                state.dispose = false;
            });

            player.on('contentupdate', function () {
                // videojs-ads triggers this when src changes
                player.vast.checkLoad();
            });

            player.on('readyforpreroll', function () {
                // if we don't have a vast url, just bail out
                if (!player.vast.isActive()) {
                    player.trigger('adscanceled');
                    return;
                }

                player.vast.load();
            });

            return {
                isActive: isActive,

                suspend: function () {
                    settings.suspend = true;
                },
                resume: function () {
                    settings.suspend = false;
                },
                setUrl: function (url) {
                    settings.url = url;
                },

                checkLoad: checkLoad,

                checkPlay: function () {
                    if (player.vast.isActive() && !state.loading) {
                        player.vast.preroll();
                    }
                },

                load: function () {
                    if (!player.vast.isActive()) {
                        return false;
                    }

                    state.loading = true;
                    player.vast.getContent(settings.url);

                    return true;
                },

                dispose: function () {
                    if (state.playing) {
                        state.dispose = true;
                        state.error = true;
                        player.trigger('adended');
                    }
                },

                createSourceObjects: function (media_files) {
                    var sourcesByFormat = {}, i, j, tech;
                    var techOrder = player.options().techOrder;
                    for (i = 0, j = techOrder.length; i < j; i++) {
                        var techName = techOrder[i].charAt(0).toUpperCase() + techOrder[i].slice(1);
                        tech = videojs[techName];

                        // Check if the current tech is defined before continuing
                        if (!tech) {
                            continue;
                        }

                        // Check if the browser supports this technology
                        if (tech.isSupported()) {
                            // Loop through each source object
                            for (var a = 0, b = media_files.length; a < b; a++) {
                                var media_file = media_files[a];
                                var source = {type: media_file.mimeType, src: media_file.fileURL};
                                // Check if source can be played with this technology
                                if (tech.canPlaySource(source)) {
                                    if (sourcesByFormat[techOrder[i]] === undefined) {
                                        sourcesByFormat[techOrder[i]] = [];
                                    }
                                    sourcesByFormat[techOrder[i]].push({
                                        type: media_file.mimeType,
                                        src: media_file.fileURL,
                                        width: media_file.width,
                                        height: media_file.height
                                    });
                                }
                            }
                        }
                    }
                    // Create sources in preferred format order
                    var sources = [];
                    for (j = 0; j < techOrder.length; j++) {
                        tech = techOrder[j];
                        if (sourcesByFormat[tech] !== undefined) {
                            for (i = 0; i < sourcesByFormat[tech].length; i++) {
                                sources.push(sourcesByFormat[tech][i]);
                            }
                        }
                    }
                    return sources;
                },

                getContent: function () {
                    var now = +new Date(),
                        url = (settings.url || "").replace(/\[timestamp\]/g, "" + now);

                    // query vast url given in settings
                    vast.client.get(url, {withCredentials: true}, function (response) {
                        if (response) {
                            // we got a response, deal with it
                            for (var adIdx = 0; adIdx < response.ads.length; adIdx++) {
                                var ad = response.ads[adIdx];
                                player.vast.companion = undefined;
                                for (var creaIdx = 0; creaIdx < ad.creatives.length; creaIdx++) {
                                    var creative = ad.creatives[creaIdx], foundCreative = false, foundCompanion = false;
                                    if (creative.type === "linear" && !foundCreative) {

                                        if (creative.mediaFiles.length) {

                                            player.vast.sources = player.vast.createSourceObjects(creative.mediaFiles);
                                            player.vast.skip = creative.skipDelay || -1;

                                            if (!player.vast.sources.length) {
                                                player.trigger('adscanceled');
                                                return;
                                            }

                                            player.vastTracker = new vast.tracker(ad, creative);

                                            foundCreative = true;
                                        }

                                    } else if (creative.type === "companion" && !foundCompanion) {

                                        player.vast.companion = creative;

                                        foundCompanion = true;

                                    }
                                }

                                if (player.vastTracker) {
                                    // vast tracker and content is ready to go, trigger event
                                    player.trigger('vast-ready');
                                    break;
                                } else {
                                    player.trigger('vast-error');
                                    // Inform ad server we can't find suitable media file for this ad
                                    vast.util.track(ad.errorURLTemplates, {ERRORCODE: 403});
                                }
                            }
                        }

                        if (!player.vastTracker) {
                            // No pre-roll, start video
                            player.trigger('adscanceled');
                        }
                    });
                },

                setupEvents: function () {

                    var canplayFn = function () {
                            player.vastTracker.load();
                        },
                        timeupdateFn = function () {
                            if (isNaN(player.vastTracker.assetDuration)) {
                                player.vastTracker.assetDuration = player.duration();
                            }
                            player.vastTracker.setProgress(player.currentTime());
                        },
                        pauseFn = function () {
                            player.vastTracker.setPaused(true);
                            player.one('adplay', playFn);
                        },
                        playFn = function () {
                            player.vastTracker.setPaused(false);
                        },
                        errorFn = function () {
                            // Inform ad server we couldn't play the media file for this ad
                            vast.util.track(player.vastTracker.ad.errorURLTemplates, {ERRORCODE: 405});
                            state.error = true;
                            player.trigger('adended');
                        },
                        endedFn = function () {
                            player.off('adplay', playFn);
                        };

                    player.on('adcanplay', canplayFn);
                    player.on('adtimeupdate', timeupdateFn);
                    player.on('adpause', pauseFn);
                    player.on('adended', endedFn);
                    player.on('aderror', errorFn);

                    player.one('vast-preroll-removed', function () {
                        player.off('adcanplay', canplayFn);
                        player.off('adtimeupdate', timeupdateFn);
                        player.off('adpause', pauseFn);
                        player.off('adended', endedFn);
                        player.off('aderror', errorFn);
                        if (!state.error) {
                            player.vastTracker.complete();
                        }
                        state.error = false;
                    });
                },

                preroll: function () {
                    player.ads.startLinearAdMode();
                    player.vast.showControls = player.controls();
                    if (player.vast.showControls) {
                        player.controls(false);
                    }

                    // load linear ad sources and start playing them
                    player.src(player.vast.sources);

                    var clickthrough;
                    if (player.vastTracker.clickThroughURLTemplate) {
                        clickthrough = vast.util.resolveURLTemplates(
                            [player.vastTracker.clickThroughURLTemplate],
                            {
                                CACHEBUSTER: Math.round(Math.random() * 1.0e+10),
                                CONTENTPLAYHEAD: player.vastTracker.progressFormated()
                            }
                        )[0];
                    }
                    var blocker = context.document.createElement("a");
                    blocker.className = "vast-blocker";
                    blocker.href = clickthrough || "#";
                    blocker.target = "_blank";
                    blocker.onclick = function () {
                        if (player.paused()) {
                            player.play();
                            return false;
                        }
                        var clicktrackers = [].concat(player.vastTracker.clickTrackingURLTemplates || []);
                        if (clicktrackers && clicktrackers.length > 0) {
                            player.vastTracker.trackURLs(clicktrackers);
                        }
                        player.trigger("adclick");
                    };
                    player.vast.blocker = blocker;
                    player.el().insertBefore(blocker, player.controlBar.el());

                    var skipButton = context.document.createElement("div");
                    skipButton.className = "vast-skip-button";
                    if (settings.skip <= 0 && player.vast.skip <= 0) {
                        skipButton.style.display = "none";
                    }
                    player.vast.skipButton = skipButton;
                    player.el().appendChild(skipButton);

                    player.on("adtimeupdate", player.vast.timeupdate);

                    skipButton.onclick = function (e) {
                        if ((' ' + player.vast.skipButton.className + ' ').indexOf(' enabled ') >= 0) {
                            player.vastTracker.skip();
                            player.vast.tearDown();
                        }
                        if (context.Event.prototype.stopPropagation !== undefined) {
                            e.stopPropagation();
                        } else {
                            return false;
                        }
                    };

                    player.vast.setupEvents();

                    player.one('adended', player.vast.tearDown);

                    player.trigger('vast-preroll-ready');
                },

                tearDown: function () {
                    // remove preroll buttons
                    player.vast.skipButton.parentNode.removeChild(player.vast.skipButton);
                    player.vast.blocker.parentNode.removeChild(player.vast.blocker);

                    // remove vast-specific events
                    player.off('adtimeupdate', player.vast.timeupdate);
                    player.off('adended', player.vast.tearDown);

                    // end ad mode
                    player.ads.endLinearAdMode();

                    // show player controls for video
                    if (player.vast.showControls) {
                        player.controls(true);
                    }

                    player.trigger('vast-preroll-removed');
                },

                timeupdate: function (e) {
                    player.loadingSpinner.el().style.display = "none";
                    var skipTime = settings.skip >= 0 && settings.skip || player.vast.skip;
                    var timeLeft = Math.ceil(skipTime - player.currentTime());
                    if (timeLeft > 0) {
                        player.vast.skipButton.innerHTML = "Skip in " + timeLeft + "...";
                    } else {
                        if ((' ' + player.vast.skipButton.className + ' ').indexOf(' enabled ') === -1) {
                            player.vast.skipButton.className += " enabled";
                            player.vast.skipButton.innerHTML = "Skip";
                        }
                    }
                }
            };

        };

        var vastPlugin = function (options) {
            var player = this;
            var settings = extend({}, defaults, options || {});

            // check that we have the ads plugin
            if (player.ads === undefined) {
                context.console.error('vast video plugin requires videojs-contrib-ads, vast plugin not initialized');
                return null;
            }

            // set up vast plugin, then set up events here
            player.vast = new Vast(player, settings);

            // make an ads request immediately so we're ready when the viewer hits "play"
            //if (player.currentSrc()) {
            //    player.vast.getContent(settings.url);
            //}

            // return player to allow this plugin to be chained
            return player;
        };

        vjs.plugin('vast', vastPlugin);

    };
}, window);