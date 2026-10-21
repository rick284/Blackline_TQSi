import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid in the app's own look: greys only, square, dense, Geist. */
export const gridTheme = themeQuartz.withParams({
  fontFamily: '"Geist Variable", system-ui, sans-serif',
  fontSize: 12,
  rowHeight: 24,
  headerHeight: 26,
  headerFontSize: 11,
  headerFontWeight: 600,
  spacing: 4,
  cellHorizontalPadding: 8,
  borderRadius: 0,
  wrapperBorderRadius: 0,
  backgroundColor: "#ffffff",
  foregroundColor: "#111111",
  headerBackgroundColor: "#dcdcdc",
  headerTextColor: "#111111",
  borderColor: "#c4c4c4",
  rowBorder: true,
  columnBorder: { style: "solid", color: "#dedede" },
  oddRowBackgroundColor: "#ffffff",
  rowHoverColor: "#ececec",
  selectedRowBackgroundColor: "#d4d4d4",
  accentColor: "#000000",
  inputFocusBorder: { color: "#000000" },
  cellEditingBorder: { color: "#000000" },
});

export const monoCell = { fontFamily: '"Geist Mono Variable", ui-monospace, monospace', textAlign: "right" as const };
