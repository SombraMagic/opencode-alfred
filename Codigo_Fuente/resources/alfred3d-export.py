# Exporta el .blend abierto (Blender se lanza con `-b <fichero>`) a GLB y deja un meta.json
# con lo que la webview necesita para pintar controles. No guarda el .blend.
# Uso: blender -b <fichero.blend> -noaudio --python alfred3d-export.py -- <salida.glb> <meta.json> <version>
import json
import os
import sys
import traceback

import bpy


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) < 3:
        raise SystemExit("Faltan argumentos: <glb> <meta.json> <version>")
    glb, meta_path = args[0], args[1]
    version = int(args[2])

    scene = bpy.context.scene
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format="GLB",
        export_cameras=True,
        export_lights=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_apply=True,
        use_visible=False,
        export_yup=True,
    )

    objects = [
        {"name": o.name, "type": o.type, "visible": not (o.hide_viewport or o.hide_render)}
        for o in scene.objects
    ]
    cameras = [
        {
            "name": o.name,
            "type": o.data.type,
            "lens": float(o.data.lens),
            "orthoScale": float(o.data.ortho_scale),
        }
        for o in scene.objects
        if o.type == "CAMERA"
    ]
    lights = [{"name": o.name, "type": o.data.type} for o in scene.objects if o.type == "LIGHT"]
    animations = []
    for action in bpy.data.actions:
        if action.users > 0:
            start, end = action.frame_range
            animations.append(
                {"name": action.name, "start": int(round(start)), "end": int(round(end))}
            )

    render = scene.render
    meta = {
        "version": version,
        "file": os.path.splitext(bpy.path.basename(bpy.data.filepath))[0],
        "fps": render.fps,
        "frameStart": scene.frame_start,
        "frameEnd": scene.frame_end,
        "frameCurrent": scene.frame_current,
        "engine": render.engine,
        "resolution": {
            "x": render.resolution_x,
            "y": render.resolution_y,
            "percent": render.resolution_percentage,
        },
        "camera": scene.camera.name if scene.camera else None,
        "objects": objects,
        "cameras": cameras,
        "lights": lights,
        "animations": animations,
    }

    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)


try:
    main()
except SystemExit:
    raise
except Exception:
    traceback.print_exc()
    # Código distinto de 0 para que el host no dé por buena una exportación a medias.
    sys.exit(1)
