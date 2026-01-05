/**
 * Type declarations for external libraries loaded via CDN.
 * These libraries are available as globals, not ES modules.
 */

// Plotly.js types (subset of the full API we use)
declare namespace Plotly {
  interface Layout {
    title?: string | { text: string; font?: Partial<Font> };
    xaxis?: Partial<LayoutAxis>;
    yaxis?: Partial<LayoutAxis>;
    yaxis2?: Partial<LayoutAxis>;
    paper_bgcolor?: string;
    plot_bgcolor?: string;
    font?: Partial<Font>;
    showlegend?: boolean;
    legend?: Partial<Legend>;
    margin?: Partial<Margin>;
    hovermode?: 'x' | 'y' | 'closest' | false | 'x unified' | 'y unified';
    barmode?: 'stack' | 'group' | 'overlay' | 'relative';
    annotations?: Partial<Annotations>[];
    shapes?: Partial<Shape>[];
    autosize?: boolean;
    height?: number;
    width?: number;
  }

  interface LayoutAxis {
    title?: string | { text: string; font?: Partial<Font> };
    type?: 'linear' | 'log' | 'date' | 'category';
    range?: [number | string, number | string];
    tickformat?: string;
    tickprefix?: string;
    ticksuffix?: string;
    showgrid?: boolean;
    gridcolor?: string;
    zeroline?: boolean;
    zerolinecolor?: string;
    showticklabels?: boolean;
    tickangle?: number;
    dtick?: number | string;
    tickmode?: 'auto' | 'linear' | 'array';
    tickvals?: (number | string)[];
    ticktext?: string[];
    overlaying?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    anchor?: string;
    domain?: [number, number];
    autorange?: boolean | 'reversed';
    fixedrange?: boolean;
    color?: string;
    tickcolor?: string;
    linecolor?: string;
  }

  interface Font {
    family?: string;
    size?: number;
    color?: string;
  }

  interface Legend {
    x?: number;
    y?: number;
    xanchor?: 'auto' | 'left' | 'center' | 'right';
    yanchor?: 'auto' | 'top' | 'middle' | 'bottom';
    orientation?: 'v' | 'h';
    bgcolor?: string;
    bordercolor?: string;
    borderwidth?: number;
    font?: Partial<Font>;
  }

  interface Margin {
    l?: number;
    r?: number;
    t?: number;
    b?: number;
    pad?: number;
  }

  interface Annotations {
    x?: number | string;
    y?: number | string;
    text?: string;
    showarrow?: boolean;
    arrowhead?: number;
    ax?: number;
    ay?: number;
    font?: Partial<Font>;
    bgcolor?: string;
    bordercolor?: string;
    borderwidth?: number;
    xref?: string;
    yref?: string;
    xanchor?: 'auto' | 'left' | 'center' | 'right';
    yanchor?: 'auto' | 'top' | 'middle' | 'bottom';
  }

  interface Shape {
    type?: 'line' | 'rect' | 'circle' | 'path';
    x0?: number | string;
    y0?: number | string;
    x1?: number | string;
    y1?: number | string;
    xref?: string;
    yref?: string;
    line?: { color?: string; width?: number; dash?: string };
    fillcolor?: string;
    opacity?: number;
  }

  interface Data {
    type?:
      | 'scatter'
      | 'bar'
      | 'pie'
      | 'heatmap'
      | 'histogram'
      | 'box'
      | 'violin'
      | 'waterfall'
      | 'indicator';
    x?: (number | string | Date)[];
    y?: (number | string)[];
    z?: number[][];
    values?: number[];
    labels?: string[];
    text?: string | string[];
    textposition?: string | string[];
    textinfo?: string;
    hovertext?: string | string[];
    hoverinfo?: string;
    hovertemplate?: string | string[];
    name?: string;
    mode?: string;
    marker?: Partial<PlotlyMarker>;
    line?: Partial<PlotlyLine>;
    fill?: 'none' | 'tozeroy' | 'tozerox' | 'tonexty' | 'tonextx' | 'toself' | 'tonext';
    fillcolor?: string;
    opacity?: number;
    showlegend?: boolean;
    legendgroup?: string;
    visible?: boolean | 'legendonly';
    xaxis?: string;
    yaxis?: string;
    hole?: number;
    pull?: number | number[];
    domain?: { x?: [number, number]; y?: [number, number] };
    measure?: ('relative' | 'total' | 'absolute')[];
    orientation?: 'v' | 'h';
    base?: number | number[];
    connector?: { line?: { color?: string; width?: number } };
    increasing?: { marker?: { color?: string } };
    decreasing?: { marker?: { color?: string } };
    totals?: { marker?: { color?: string } };
    delta?: { reference?: number; position?: string };
    gauge?: {
      axis?: { range?: [number, number]; ticksuffix?: string };
      bar?: { color?: string };
      steps?: { range: [number, number]; color: string }[];
      threshold?: { line?: { color: string; width: number }; thickness: number; value: number };
    };
    number?: { suffix?: string; prefix?: string; font?: Partial<Font> };
    title?: { text?: string; font?: Partial<Font> };
  }

  interface PlotlyMarker {
    color?: string | string[] | number[];
    colors?: string[];
    size?: number | number[];
    symbol?: string | string[];
    line?: { color?: string; width?: number };
    opacity?: number | number[];
    colorscale?: string | [number, string][];
    showscale?: boolean;
    colorbar?: Partial<ColorBar>;
  }

  interface ColorBar {
    title?: string | { text: string };
    ticksuffix?: string;
    tickprefix?: string;
  }

  interface PlotlyLine {
    color?: string;
    width?: number;
    dash?: 'solid' | 'dot' | 'dash' | 'longdash' | 'dashdot' | 'longdashdot';
    shape?: 'linear' | 'spline' | 'hv' | 'vh' | 'hvh' | 'vhv';
  }

  interface Config {
    responsive?: boolean;
    displayModeBar?: boolean | 'hover';
    displaylogo?: boolean;
    modeBarButtonsToRemove?: string[];
    modeBarButtonsToAdd?: string[];
    scrollZoom?: boolean;
    staticPlot?: boolean;
  }

  function newPlot(
    graphDiv: string | HTMLElement,
    data: Data[],
    layout?: Partial<Layout>,
    config?: Partial<Config>
  ): Promise<void>;

  function react(
    graphDiv: string | HTMLElement,
    data: Data[],
    layout?: Partial<Layout>,
    config?: Partial<Config>
  ): Promise<void>;

  function relayout(graphDiv: string | HTMLElement, update: Partial<Layout>): Promise<void>;

  function purge(graphDiv: string | HTMLElement): void;

  function update(
    graphDiv: string | HTMLElement,
    dataUpdate: Partial<Data>,
    layoutUpdate?: Partial<Layout>
  ): Promise<void>;

  function restyle(
    graphDiv: string | HTMLElement,
    update: Partial<Data>,
    indices?: number | number[]
  ): Promise<void>;
}

// marked.js types
declare namespace marked {
  interface MarkedOptions {
    gfm?: boolean;
    breaks?: boolean;
    pedantic?: boolean;
    sanitize?: boolean;
    smartLists?: boolean;
    smartypants?: boolean;
    headerIds?: boolean;
    mangle?: boolean;
  }

  function parse(src: string, options?: MarkedOptions): string;
  function setOptions(options: MarkedOptions): void;
}

// sql.js types
declare interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

declare interface SqlJsDatabase {
  run(sql: string, params?: SqlJsBindParams): void;
  getQueryResults(sql: string, params?: SqlJsBindParams): SqlJsQueryResult[];
  prepare(sql: string): SqlJsStatement;
  exportData(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}

declare interface SqlJsStatement {
  bind(params?: SqlJsBindParams): boolean;
  step(): boolean;
  get(params?: SqlJsBindParams): SqlJsValueType[];
  getAsObject(params?: SqlJsBindParams): Record<string, SqlJsValueType>;
  run(params?: SqlJsBindParams): void;
  reset(): void;
  free(): boolean;
}

declare type SqlJsValueType = number | string | Uint8Array | null;
declare type SqlJsBindParams = SqlJsValueType[] | Record<string, SqlJsValueType>;

declare interface SqlJsQueryResult {
  columns: string[];
  values: SqlJsValueType[][];
}

declare interface SqlJsConfig {
  locateFile?: (filename: string) => string;
}

declare function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;

// Extend Window interface for global access
declare global {
  interface Window {
    Plotly: typeof Plotly;
    marked: typeof marked;
    initSqlJs: typeof initSqlJs;
  }
}

export {};
