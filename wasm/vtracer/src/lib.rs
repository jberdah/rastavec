use serde::Deserialize;
use vtracer::{ColorImage, Config};
use wasm_bindgen::prelude::*;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    clustering: Option<String>,
    watershed_detail: Option<u32>,
    hierarchical: Option<String>,
    mode: Option<String>,
    filter_speckle: Option<usize>,
    color_precision: Option<i32>,
    layer_difference: Option<i32>,
    corner_threshold: Option<i32>,
    length_threshold: Option<f64>,
    max_iterations: Option<usize>,
    splice_threshold: Option<i32>,
    path_precision: Option<u32>,
    optimize: Option<u8>,
    detect_shapes: Option<bool>,
    preserve_gradients: Option<bool>,
    binary_threshold: Option<u8>,
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn config_from(options: JsValue) -> Result<Config, JsValue> {
    let options: Options = if options.is_undefined() || options.is_null() {
        Options::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(js_error)?
    };

    let mut config = Config::default();
    if let Some(value) = options.clustering {
        config.clustering = value.parse().map_err(js_error)?;
    }
    if let Some(value) = options.watershed_detail {
        config.watershed_detail = value;
    }
    if let Some(value) = options.hierarchical {
        config.hierarchical = value.parse().map_err(js_error)?;
    }
    if let Some(value) = options.mode {
        config.mode = value.parse().map_err(js_error)?;
    }
    if let Some(value) = options.filter_speckle {
        config.filter_speckle = value;
    }
    if let Some(value) = options.color_precision {
        config.color_precision = value;
    }
    if let Some(value) = options.layer_difference {
        config.layer_difference = value;
    }
    if let Some(value) = options.corner_threshold {
        config.corner_threshold = value;
    }
    if let Some(value) = options.length_threshold {
        config.length_threshold = value;
    }
    if let Some(value) = options.max_iterations {
        config.max_iterations = value;
    }
    if let Some(value) = options.splice_threshold {
        config.splice_threshold = value;
    }
    if let Some(value) = options.path_precision {
        config.path_precision = Some(value);
    }
    if let Some(value) = options.optimize {
        config.optimize = value;
    }
    if let Some(value) = options.binary_threshold {
        config.binary_threshold = value;
    }
    if let Some(value) = options.detect_shapes {
        config.detect_shapes = value;
    }
    if let Some(value) = options.preserve_gradients {
        config.preserve_gradients = value;
    }
    Ok(config)
}

fn checked_image(data: Vec<u8>, width: usize, height: usize) -> Result<ColorImage, JsValue> {
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| js_error("image dimensions overflow the RGBA buffer size"))?;
    if width == 0 || height == 0 || data.len() != expected {
        return Err(js_error(format!(
            "invalid RGBA image: got {} bytes for {width}×{height} pixels",
            data.len()
        )));
    }

    Ok(ColorImage {
        pixels: data,
        width,
        height,
    })
}

/// Trace one opaque RGBA image and return VTracer's SVG document.
#[wasm_bindgen]
pub fn vectorize_rgba(
    data: Vec<u8>,
    width: usize,
    height: usize,
    options: JsValue,
) -> Result<String, JsValue> {
    let image = checked_image(data, width, height)?;
    config_from(options)?.build().map_err(js_error)?.to_svg(&image).map_err(js_error)
}

/// Trace one RGBA image and also describe every shape of the result.
/// Returns `[svg, reportJson]`; the report lists, per `<path>` in document
/// order, exact circles, gradient paints and overlay-to-base links.
#[wasm_bindgen]
pub fn vectorize_rgba_structured(
    data: Vec<u8>,
    width: usize,
    height: usize,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    let image = checked_image(data, width, height)?;
    let (svg, report) = config_from(options)?
        .build()
        .map_err(js_error)?
        .to_svg_with_report(&image)
        .map_err(js_error)?;
    serde_wasm_bindgen::to_value(&(svg, report.to_json())).map_err(js_error)
}
