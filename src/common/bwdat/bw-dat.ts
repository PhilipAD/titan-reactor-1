import { GrpSprite, IScriptDATType } from "../types";
import { ImageDAT } from "./images-dat";
import { OrderDAT } from "./orders-dat";
import { LoDAT } from "./parse-lo";
import { PortraitDAT } from "./portraits-dat";
import { SoundDAT } from "./sounds-dat";
import { SpriteDAT } from "./sprites-dat";
import { TechDataDAT } from "./tech-data-dat";
import { UnitDAT } from "./units-dat";
import { UpgradeDAT } from "./upgrades-dat";
import { WeaponDAT } from "./weapons-dat";

/**
 * @public
 */
export interface BwDAT {
    iscript: IScriptDATType;
    sounds: SoundDAT[];
    tech: TechDataDAT[];
    upgrades: UpgradeDAT[];
    orders: OrderDAT[];
    units: UnitDAT[];
    images: ImageDAT[];
    los: LoDAT[];
    sprites: SpriteDAT[];
    weapons: WeaponDAT[];
    grps: GrpSprite[];
    /**
     * Hermes 2026-04 deeper rebuild — talking-portrait table from
     * arr/portdata.dat (220 entries). Empty array if the file is missing.
     */
    portraits: PortraitDAT[];
    /**
     * Hermes 2026-04 deeper rebuild — full string table from
     * rez/stat_txt.tbl / arr/strings.tbl (~3000 entries). Indexed by string
     * id (the same ids stored in units.dat / orders.dat). Empty array if
     * the file is missing.
     */
    strings: string[];
}
