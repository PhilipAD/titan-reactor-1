import { DirectionalLight, Object3D, Color, Vector3 } from "three";
import { getTitanWebGLCompatMode } from "common/titan-webgl-compat";

const createDirectional = ( mapWidth: number, mapHeight: number ) => {
    const webglCompat = getTitanWebGLCompatMode();
    const light = new DirectionalLight( 0xffffff, 2.5 );
    light.position.set( -32, 13, -26 );
    light.target = new Object3D();
    // Shadow map sampling is one of the most expensive things SwiftShader does.
    // A 4096x4096 shadow map is ~67MP rasterized every frame the shadow updates.
    // In compat mode we disable shadows entirely and keep a tiny placeholder map.
    light.castShadow = !webglCompat;
    light.shadow.camera.near = 1;
    light.shadow.camera.far = 1000;
    light.shadow.normalBias = 0;
    light.shadow.radius = 2;

    const sizeW = mapWidth * 1.5;
    const sizeh = mapHeight * 1.5;

    light.shadow.camera.left = -sizeW;
    light.shadow.camera.right = sizeW;
    light.shadow.camera.top = sizeh;
    light.shadow.camera.bottom = -sizeh;
    const shadowMap = webglCompat ? 256 : 512 * 8;
    light.shadow.mapSize.width = shadowMap;
    light.shadow.mapSize.height = shadowMap;
    light.shadow.autoUpdate = !webglCompat;
    light.shadow.needsUpdate = !webglCompat;
    light.layers.enableAll();

    return light;
};
export class Sunlight {
    #light: DirectionalLight;
    shadowIntensity = 1;
    #quality = 1;

    constructor( mapWidth: number, mapHeight: number ) {
        this.#light = createDirectional( mapWidth, mapHeight );
    }

    get children() {
        return [this.#light, this.target];
    }

    set enabled( val: boolean ) {
        this.#light.visible = val;
    }

    set intensity( value: number ) {
        this.#light.intensity = value * this.shadowIntensity;
    }

    get target() {
        return this.#light.target;
    }

    setPosition( ...args: Parameters<Vector3["set"]> ) {
        this.#light.position.set( ...args );
    }

    getPosition() {
        return this.#light.position.clone();
    }

    setColor( ...args: Parameters<Color["setStyle"]> ) {
        this.#light.color.setStyle( ...args );
    }

    needsUpdate() {
        this.#light.shadow.needsUpdate = true;
        this.#light.updateMatrix();
        this.#light.updateMatrixWorld();
    }

    set shadowQuality( quality: number ) {
        // In compat mode we pin shadows off regardless of what the UI requests.
        if ( getTitanWebGLCompatMode() ) {
            this.#light.castShadow = false;
            return;
        }
        this.#light.castShadow = quality > 0;
        if ( !this.#light.castShadow ) {
            return;
        }
        this.#quality = quality;
        this.#light.shadow.mapSize.width = 512 * quality;
        this.#light.shadow.mapSize.height = 512 * quality;
        this.#light.shadow.needsUpdate = true;
    }

    get shadowQuality() {
        return this.#quality;
    }

    dispose() {
        this.#light.dispose();
    }
}
