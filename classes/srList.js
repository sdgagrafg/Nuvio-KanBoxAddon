const { repairLivePoster, shapeLiveCatalogMeta, shapeLiveDetailMeta } = require("./liveChannels");
const { repairTitle } = require("./repairTitle");
const { hasNumberedSeason } = require("./tmdbSeason");

class srList {
    constructor() {
        this._seriesList = {};
        this._databaseManager = null;
    }

    setDatabaseManager(dbManager) {
        this._databaseManager = dbManager;
    }

    get seriesList() {
        return this._seriesList;
    }

    addItemByDetails(id, name, poster, description, link, background, genres, metas, type, subType, latestEpisodeDate) {
        const item = {
            id,
            type,
            subtype: subType,
            name,
            poster,
            link,
            background,
            genres,
            meta: metas,
            latestEpisodeDate,
            description: description !== undefined ? description : ""
        };

        this._addItem(item);
    }

    getList() {
        return this._seriesList;
    }

    // Select the first valid absolute HTTP(S) poster URL available.
    // Prefer the top-level poster, then fall back to nested metadata.
    _getPoster(value) {
        const candidates = [
            value?.poster,
            value?.meta?.poster
        ];

        return candidates.find(poster =>
            typeof poster === "string" &&
            /^https?:\/\/\S+$/i.test(poster.trim())
        )?.trim() || "";
    }

    getMetasByType(type) {
        const metas = [];

        for (const value of Object.values(this._seriesList)) {
            if (value.type === type) {
                metas.push(this._formatCatalogMeta(value));
            }
        }

        return metas;
    }

    _formatCatalogMeta(value) {
        if (value && value.meta && value.id && value.type) {
            const sourcePoster = this._getPoster(value);
            const poster = value.type === "tv"
                ? repairLivePoster(value.id, sourcePoster)
                : sourcePoster;

            const sourceBackground =
                value.background || value.meta.background || poster;

            const background = value.type === "tv"
                ? repairLivePoster(value.id, sourceBackground)
                : sourceBackground;

            return shapeLiveCatalogMeta({
                id: value.id,
                type: value.type,
                name: value.name || value.meta.name,
                poster,
                posterShape: value.meta.posterShape || value.posterShape || "poster",
                background,
                description: value.description || value.meta.description || "",
                genres: value.genres || value.meta.genres || [],
                subtype: value.subtype,
                link: value.link,
                tmdbId: value.meta.tmdbId || value.tmdbId
            });
        }

        return value;
    }

    _mergeMetasById(lists) {
        const seen = new Set();
        const metas = [];

        for (const list of lists) {
            for (const meta of list) {
                if (!meta || !meta.id || seen.has(meta.id)) continue;
                seen.add(meta.id);
                metas.push(meta);
            }
        }

        return metas;
    }

    getMetasBySubtypes(subtypes) {
        return this._mergeMetasById(
            (subtypes || []).map(subtype => this.getMetasBySubtype(subtype))
        );
    }

    getMetasBySubtypesAndName(subtypes, nameToSearch) {
        return this._mergeMetasById(
            (subtypes || []).map(subtype =>
                this.getMetasBySubtypeAndName(subtype, nameToSearch)
            )
        );
    }

    _formatSubtypeMeta(value) {
        if (value.meta && value.id && value.type) {
            const poster = this._getPoster(value);

            return {
                id: value.id,
                type: value.type,
                name: value.name || value.meta.name,
                poster,
                posterShape: value.meta.posterShape || value.posterShape || "poster",
                background: value.background || value.meta.background || poster,
                description: value.description || value.meta.description || "",
                genres: value.genres || value.meta.genres || [],
                subtype: value.subtype,
                link: value.link,
                tmdbId: value.meta.tmdbId || value.tmdbId,
                latestEpisodeDate: value.latestEpisodeDate,
                videos: value.meta.videos || []
            };
        }

        return value;
    }

    getMetasBySubtype(subtype) {
        const metas = [];

        for (const value of Object.values(this._seriesList)) {
            if (value.subtype === subtype) {
                metas.push(this._formatSubtypeMeta(value));
            }
        }

        if (subtype !== "tv") {
            metas.sort((a, b) => {
                const dateA = a.latestEpisodeDate
                    ? new Date(a.latestEpisodeDate).getTime()
                    : 0;
                const dateB = b.latestEpisodeDate
                    ? new Date(b.latestEpisodeDate).getTime()
                    : 0;

                return dateB - dateA;
            });
        }

        return metas;
    }

    getMetasBySubtypeAndName(subtype, nameToSearch) {
        const rawSearch = (nameToSearch || "").trim();

        if (rawSearch === "*") {
            return this.getMetasBySubtype(subtype);
        }

        const searchTerm = repairTitle(rawSearch)
            .normalize("NFKC")
            .toLowerCase();

        const metas = [];

        for (const value of Object.values(this._seriesList)) {
            if (value.subtype !== subtype) continue;

            const seriesName = value.name
                ? repairTitle(value.name).normalize("NFKC").toLowerCase()
                : "";

            if (seriesName.includes(searchTerm)) {
                metas.push(this._formatSubtypeMeta(value));
            }
        }

        return metas;
    }

    async getMetaById(id) {
        const log4js = require("./logger");
        const logger = log4js.getLogger("srList");

        if (this._seriesList[id] === undefined) {
            logger.debug("getMetaById => id not found in memory: " + id);

            if (this._databaseManager) {
                try {
                    logger.debug("getMetaById => Attempting to load series from database: " + id);

                    const seriesFromDb = await this._databaseManager.loadSeriesById(id);

                    if (seriesFromDb) {
                        this._seriesList[id] = seriesFromDb;
                        logger.debug(
                            "getMetaById => Loaded series from database: " +
                            id + " (" + seriesFromDb.name + ")"
                        );
                    } else {
                        logger.debug("getMetaById => Series not found in database: " + id);
                        return {};
                    }
                } catch (error) {
                    logger.error("getMetaById => Failed to load series from database: " + error.message);
                    return {};
                }
            } else {
                return {};
            }
        }

        const item = this._seriesList[id];

        if (item.meta) {
            const needsLazyLoad = !item.meta.videos || item.meta.videos.length === 0;

            if (needsLazyLoad && this._databaseManager) {
                logger.debug("getMetaById => Lazy-loading videos for: " + id);

                try {
                    const videos = await this._databaseManager.loadVideosForSeries(id);

                    if (videos && videos.length > 0) {
                        item.meta.videos = videos;
                        logger.debug("getMetaById => Loaded " + videos.length + " videos for " + id);
                    }
                } catch (error) {
                    logger.error("getMetaById => Failed to lazy-load videos: " + error.message);
                }
            }

            const sourcePoster = this._getPoster(item);
            const poster = item.type === "tv"
                ? repairLivePoster(item.id, sourcePoster)
                : sourcePoster;

            const sourceBackground =
                item.background || item.meta.background || poster;

            const background = item.type === "tv"
                ? repairLivePoster(item.id, sourceBackground)
                : sourceBackground;

            const result = {
                id: item.id,
                type: item.type,
                subtype: item.subtype,
                name: item.name || item.meta.name,
                poster,
                posterShape: item.meta.posterShape || item.posterShape || "poster",
                background,
                link: item.link,
                genres: item.genres || item.meta.genres || [],
                videos: item.meta.videos || [],
                description: item.meta.description || item.description || "",
                tmdbId: item.meta.tmdbId || item.tmdbId
            };

            logger.debug(
                "getMetaById => returning database item with id: " +
                result.id + " name: " + result.name +
                " videos: " + result.videos.length
            );

            return shapeLiveDetailMeta(result);
        }

        logger.debug("getMetaById => returning ZIP item with id: " + item.id);
        return shapeLiveDetailMeta(item);
    }

    async getStreamsById(id) {
        let seriesId = id;

        if (seriesId.indexOf(":") > 0) {
            seriesId = id.split(":")[0];
        }

        const meta = await this.getMetaById(seriesId);
        if (!meta) return [];

        if (meta.streams) {
            return meta.streams;
        }

        const videos = meta.videos;
        if (!videos) return [];

        for (const video of videos) {
            if (video.id === id) {
                return video.streams || [];
            }
        }

        return [];
    }

    async getVideoById(id) {
        const log4js = require("./logger");
        const logger = log4js.getLogger("srList");

        logger.info("getVideoById => Looking for video ID: " + id);

        const seriesId = id.indexOf(":") > 0 ? id.split(":")[0] : id;
        const meta = await this.getMetaById(seriesId);

        if (!meta || !meta.videos) return null;

        for (const video of meta.videos) {
            if (video.id === id) {
                return video;
            }
        }

        return null;
    }

    async setVideosById(id, videos) {
        if (!id) return;

        const meta = await this.getMetaById(id);
        if (meta) {
            meta.videos = videos;
        }
    }

    async setStreamsById(id, streams) {
        const separator = id.indexOf(":");
        if (separator < 0) return;

        const seriesId = id.substring(0, separator);
        const meta = await this.getMetaById(seriesId);
        if (!meta || !meta.videos) return;

        for (const video of meta.videos) {
            if (video.id === id) {
                video.streams = streams;
            }
        }
    }

    findSeriesByTmdbId(tmdbId) {
        if (!tmdbId) return null;

        for (const value of Object.values(this._seriesList)) {
            if (value.meta && value.meta.tmdbId === tmdbId) {
                return value;
            }
        }

        return null;
    }

    findVideoByTmdbEpisodeId(tmdbEpisodeId) {
        if (!tmdbEpisodeId) return null;

        for (const [seriesId, value] of Object.entries(this._seriesList)) {
            if (value.meta && value.meta.videos) {
                for (const video of value.meta.videos) {
                    if (video.tmdbEpisodeId === tmdbEpisodeId) {
                        return { seriesId, video };
                    }
                }
            }
        }

        return null;
    }

    findEpisodeByTmdbSeriesAndSeEp(tmdbSeriesId, season, episode) {
        if (!tmdbSeriesId) return null;

        const series = this.findSeriesByTmdbId(tmdbSeriesId);
        if (!series || !series.meta || !series.meta.videos) return null;

        for (const video of series.meta.videos) {
            if (!hasNumberedSeason(video)) continue;

            const videoSeason = video.season != null
                ? parseInt(video.season, 10)
                : 1;
            const videoEpisode = video.episode != null
                ? parseInt(video.episode, 10)
                : 1;

            if (videoSeason === season && videoEpisode === episode) {
                return { seriesId: series.id, video };
            }
        }

        return null;
    }

    isValueExistById(id) {
        return this._seriesList[id] !== undefined;
    }

    _addItem(item) {
        const errObj = this._validateSeriesEntryDetailed(item.id);

        if (errObj.errorStatus) {
            return errObj.errorMessage + " Ignoring...";
        }

        this._seriesList[item.id] = item;
    }

    _validateSeriesEntryDetailed(id) {
        const errObj = {
            errorStatus: false,
            errorMessage: ""
        };

        if (id == null || id === "") {
            errObj.errorStatus = true;
            errObj.errorMessage = "Series ID is either empty or null. Cannot add series.";
            return errObj;
        }

        if (this.isValueExistById(id)) {
            errObj.errorStatus = true;
            errObj.errorMessage = "Series Id " + id + " already exists.";
        }

        return errObj;
    }

    _validateSeriesEntry(item) {
        return this._validateSeriesEntryDetailed(item.id);
    }
}

module.exports = srList;
