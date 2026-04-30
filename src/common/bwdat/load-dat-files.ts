import { Grp } from "common/image/grp";
import { parseIScriptBin } from "./parse-iscript-bin";

import { ReadFile, AnimFrame, GrpSprite } from "../types";
import range from "../utils/range";
import { BwDAT } from "./bw-dat";
import { FlingiesDAT } from "./flingy-dat";
import { ImagesDAT } from "./images-dat";
import { OrdersDAT } from "./orders-dat";
import { LoDAT, parseLo } from "./parse-lo";
import { SoundsDAT } from "./sounds-dat";
import { SpritesDAT } from "./sprites-dat";
import { TechDatasDAT } from "./tech-data-dat";
import { UnitDAT, UnitsDAT } from "./units-dat";
import { UpgradesDAT } from "./upgrades-dat";
import { WeaponsDAT } from "./weapons-dat";
import { PortraitsDAT } from "./portraits-dat";
import { TBL } from "./tbl";

/**
 * Best-effort wrapper around readFile for files that may not exist on every
 * SC install (e.g. very old CASC dumps). Returns null on any failure so the
 * higher-level loaders can degrade gracefully (PortraitsDAT, strings.tbl).
 */
async function tryReadFile(
    readFile: ReadFile,
    path: string
): Promise<Buffer | null> {
    try {
        const buf = await readFile( path );
        return buf && buf.length > 0 ? buf : null;
    } catch {
        return null;
    }
}

export async function loadDATFiles( readFile: ReadFile ): Promise<BwDAT> {
    const iscript = parseIScriptBin( await readFile( "scripts/iscript.bin" ) );

    const imagesDat = new ImagesDAT( readFile );
    const images = await imagesDat.load();

    const los: LoDAT[] = [];
    for ( let i = 0; i < imagesDat.stats.length; i++ ) {
        if ( imagesDat.stats[i]!.includes( ".lo" ) ) {
            const fpath = "unit/" + imagesDat.stats[i]!.replace( /\\/g, "/" );
            los[i] = parseLo( await readFile( fpath ) );
        }
    }
    const sprites = await new SpritesDAT( readFile, images ).load();
    const flingy = await new FlingiesDAT( readFile, sprites ).load();
    const weapons = await new WeaponsDAT( readFile, flingy ).load();
    const sounds = await new SoundsDAT( readFile ).load();

    const units = ( await new UnitsDAT( readFile, flingy, sounds ).load() ).map(
        ( u ) => new UnitDAT( u )
    );

    const tech = await new TechDatasDAT( readFile ).load();
    const upgrades = await new UpgradesDAT( readFile ).load();
    const orders = await new OrdersDAT( readFile ).load();

    // Hermes 2026-04 deeper rebuild: PortraitsDAT was implemented but never
    // instantiated. Loading it is one line + a try/catch (older CASC dumps
    // sometimes ship arr/portdata.dat under a different name). Result: 220
    // talking-portrait names indexed by portrait id, ready to be used by
    // any HUD that wants animated agent portraits.
    let portraits: { filename: string }[] = [];
    try {
        portraits = await new PortraitsDAT( readFile ).load();
    } catch ( err ) {
        console.warn( "[loadDATFiles] PortraitsDAT failed (non-fatal):", err );
    }

    // Hermes 2026-04 deeper rebuild: strings.tbl is the master mission /
    // dialogue / unit-name string table (~3000 strings). It already has a
    // parser (TBL.parse). Expose it as bwDat.strings so the dashboard can
    // pull authentic SC unit names, mission text, tip-of-the-day quotes,
    // etc instead of hardcoding English fallbacks.
    let strings: string[] = [];
    const stringsBuf = await tryReadFile( readFile, "rez/stat_txt.tbl" );
    const strBufFinal =
        stringsBuf ??
        ( await tryReadFile( readFile, "arr/stat_txt.tbl" ) ) ??
        ( await tryReadFile( readFile, "rez/strings.tbl" ) ) ??
        ( await tryReadFile( readFile, "arr/strings.tbl" ) );
    if ( strBufFinal ) {
        try {
            strings = TBL.parse( strBufFinal );
        } catch ( err ) {
            console.warn( "[loadDATFiles] strings.tbl parse failed:", err );
        }
    }

    const bufs = await Promise.all(
        images.map( ( image ) => readFile( `unit/${image.grpFile.replace( /\\/g, "/" )}` ) )
    );

    const grps = bufs.map( ( buf ): GrpSprite => {
        const grp = new Grp( buf );
        const frames = range( 0, grp.frameCount() ).map( ( frame ): AnimFrame => {
            const { x, y, w, h } = grp.header( frame );
            //FIXME: calculate xoff, yoff
            return { x, y, w, h, xoff: 0, yoff: 0 };
        } );
        const maxFrameH = frames.reduce( ( max, { h } ) => {
            return h > max ? h : max;
        }, 0 );
        const maxFramew = frames.reduce( ( max, { w } ) => {
            return w > max ? w : max;
        }, 0 );

        const { w, h } = grp.maxDimensions();
        return {
            w,
            h,
            frames,
            maxFrameH,
            maxFramew,
        };
    } );

    return {
        iscript,
        sounds,
        tech,
        upgrades,
        orders,
        units,
        images,
        los,
        sprites,
        weapons,
        grps,
        portraits,
        strings,
    };
}
