fn main() {
    // Desktop-only plugins (updater, global shortcut) are not dependencies on mobile,
    // so their permissions live in capabilities/desktop/ and are only loaded there.
    let mobile = matches!(std::env::var("CARGO_CFG_TARGET_OS").as_deref(), Ok("android" | "ios"));
    let pattern = if mobile { "./capabilities/*.json" } else { "./capabilities/**/*.json" };
    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(pattern)).expect("tauri build failed");
}
