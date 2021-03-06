import {Signal0, Signal, Signalable} from "./signaling"
import {HasProps} from "./has_props"  // XXX: only for type purpose
import * as enums from "./enums"
import {Arrayable} from "./types"
import {is_svg_color} from "./util/svg_colors"
import {valid_rgb} from "./util/color"
import {includes, repeat} from "./util/array"
import {map} from "./util/arrayable"
import {isBoolean, isNumber, isString, isArray, isPlainObject} from "./util/types"
import {ColumnarDataSource} from "../models/sources/columnar_data_source"

Signal; // XXX: silence TS, because `Signal` appears in declarations due to Signalable

function valueToString(value: any): string {
  try {
    return JSON.stringify(value)
  } catch {
    return value.toString()
  }
}

export function isSpec(obj: any): boolean {
  return isPlainObject(obj) &&
          ((obj.value === undefined ? 0 : 1) +
           (obj.field === undefined ? 0 : 1) +
           (obj.expr  === undefined ? 0 : 1) == 1) // garbage JS XOR
}

//
// Property base class
//

export class Property<T> extends Signalable() {

  _spec: {
    value?: any
    field?: string
    expr?: any
    transform?: any // Transform
    units?: any
  }

  optional: boolean = false

  dataspec: boolean // prototype

  readonly change: Signal0<HasProps>

  constructor(readonly obj: HasProps,
              readonly attr: string,
              readonly default_value?: (obj: HasProps) => T) {
    super()
    this.obj = obj
    this.attr = attr
    this.default_value = default_value
    this.change = new Signal0(this.obj, "change")
    this._init()
    this.connect(this.change, () => this._init())
  }

  update(): void {
    this._init()
  }

  // ----- customizable policies

  init(): void {}

  transform(values: any): any {
    return values
  }

  validate(_value: any): void {}

  // ----- property accessors

  // this function will return undefined without error if there is no value defined
  value_optional(do_spec_transform: boolean = true): any {
    // if this property is not a dataspec, just return the attribute value
    if (!this.dataspec) {
      return this.transform([this.obj.getv(this.attr)])[0]
    }

    const value = this._spec.value
    if (value === undefined)
     return undefined

    // This is unfortunately confusing. The first transform is an intrinsic
    // transform defined by the property itself, and the second is an optional
    // transform that a user has applied to the data spec
    let ret = this.transform([value])[0]
    const spec_transform = this.get_transform()
    if (spec_transform != null && do_spec_transform)
      ret = spec_transform.compute(ret)
    return ret
  }

  // this function will raise an error if there is no value defined
  value(do_spec_transform: boolean = true): any {
    const ret = this.value_optional(do_spec_transform)
    if (ret === undefined)
      throw new Error(`attempted to retrieve property value for '${this.attr}' which has no value specification`)
    return ret
  }


  array(source: ColumnarDataSource): any[] {
    if (!this.dataspec)
      throw new Error("attempted to retrieve dataspec array for non-dataspec property")

    let ret: any

    const field = this.get_field()
    const expr = this.get_expr()
    if (field != null) {
      ret = this.transform(source.get_column(field))
      if (ret == null)
        throw new Error(`attempted to retrieve property array for nonexistent field '${field}'`)
    } else if (expr != null) {
      ret = this.transform(expr.v_compute(source))
    } else {
      let length = source.get_length()
      if (length == null)
        length = 1
      const value = this.value(false) // don't apply any spec transform
      ret = repeat(value, length)
    }

    const transform = this.get_transform()
    if (transform != null)
      ret = transform.v_compute(ret)
    return ret
  }

  get_expr(): any {
    if (!this.dataspec)
      throw new Error("attempted to retrieve dataspec expr for non-dataspec property")
    return this._spec.expr
  }

  get_field(): any {
    if (!this.dataspec)
      throw new Error("attempted to retrieve dataspec field for non-dataspec property")
    return this._spec.field
  }

  get_transform(): any {
    if (!this.dataspec)
      throw new Error("attempted to retrieve dataspec transform for non-dataspec property")
    return this._spec.transform
  }

  // ----- private methods

  /*protected*/ _init(): void {
    const obj = this.obj
    const attr = this.attr
    let attr_value: any = obj.getv(attr)

    if (attr_value === undefined) {
      const default_value = this.default_value
      if (default_value !== undefined)
        attr_value = default_value(obj)
      else
        attr_value = null
      obj.setv({[attr]: attr_value}, {silent: true, defaults: true})
    }

    if (this.dataspec) {
      if (isArray(attr_value))
        this._spec = {value: attr_value}
      else if (isSpec(attr_value))
        this._spec = attr_value
      else
        this._spec = {value: attr_value}

      const field = this.get_field()
      if (field != null && !isString(field))
        throw new Error(`field value for dataspec property '${attr}' is not a string`)

      const value = this.value_optional()
      if (value != null)
        this.validate(value)
    }

    this.init()
  }

  toString(): string {
    /*${this.name}*/
    return `Prop(${this.obj}.${this.attr}, spec: ${valueToString(this._spec)})`
  }
}

Property.prototype.dataspec = false

//
// Simple Properties
//

export function simple_prop<T>(name: string, pred: (value: any) => boolean) {
  return class extends Property<T> {
    validate(value: any): void {
      if (!pred(value))
        throw new Error(`${name} property '${this.attr}' given invalid value: ${valueToString(value)}`)
    }
  }
}

export class Any extends simple_prop("Any", (_x) => true) {}

export class Array extends simple_prop("Array", (x) => isArray(x) || x instanceof Float64Array) {}

export class Bool extends simple_prop("Bool", isBoolean) {}
export const Boolean = Bool

export class Color extends simple_prop("Color", (x) => is_svg_color(x.toLowerCase()) || x.substring(0, 1) == "#" || valid_rgb(x)) {}

export class Instance extends simple_prop("Instance", (x) => x.properties != null) {}

// TODO (bev) separate booleans?
export class Number extends simple_prop("Number", (x) => isNumber(x) || isBoolean(x)) {}
export const Int = Number

export class Angle extends Number {}

// TODO extend Number instead of copying it's predicate
//class Percent extends Number("Percent", (x) -> 0 <= x <= 1.0)
export class Percent extends simple_prop("Number", (x) => (isNumber(x) || isBoolean(x)) && 0 <= x && x <= 1.0) {}

export class String extends simple_prop("String", isString) {}
export const FontSize = String

// TODO (bev) don't think this exists python side
export class Font extends String {}


//
// Enum properties
//

export function enum_prop<T>(name: string, enum_values: T[]) {
  return class extends simple_prop(name, (x) => includes(enum_values, x)) {}
}

export class Anchor extends enum_prop("Anchor", enums.LegendLocation) {}

export class AngleUnits extends enum_prop("AngleUnits", enums.AngleUnits) {}

export class Direction extends enum_prop("Direction", enums.Direction) {
  transform(values: any): any {
    const result = new Uint8Array(values.length)
    for (let i = 0; i < values.length; i++) {
      switch (values[i]) {
        case "clock":     result[i] = 0; break
        case "anticlock": result[i] = 1; break
      }
    }
    return result
  }
}

export class Dimension extends enum_prop("Dimension", enums.Dimension) {}

export class Dimensions extends enum_prop("Dimensions", enums.Dimensions) {}

export class FontStyle extends enum_prop("FontStyle", enums.FontStyle) {}

export class LatLon extends enum_prop("LatLon", enums.LatLon) {}

export class LineCap extends enum_prop("LineCap", enums.LineCap) {}

export class LineJoin extends enum_prop("LineJoin", enums.LineJoin) {}

export class LegendLocation extends enum_prop("LegendLocation", enums.LegendLocation) {}

export class Location extends enum_prop("Location", enums.Location) {}

export class OutputBackend extends enum_prop("OutputBackend", enums.OutputBackend) {}

export class Orientation extends enum_prop("Orientation", enums.Orientation) {}

export class VerticalAlign extends enum_prop("VerticalAlign", enums.VerticalAlign) {}

export class TextAlign extends enum_prop("TextAlign", enums.TextAlign) {}

export class TextBaseline extends enum_prop("TextBaseline", enums.TextBaseline) {}

export class RenderLevel extends enum_prop("RenderLevel", enums.RenderLevel) {}

export class RenderMode extends enum_prop("RenderMode", enums.RenderMode) {}

export class SizingMode extends enum_prop("SizingMode", enums.SizingMode) {}

export class SpatialUnits extends enum_prop("SpatialUnits", enums.SpatialUnits) {}

export class Distribution extends enum_prop("Distribution", enums.Distribution) {}

export class StepMode extends enum_prop("StepMode", enums.StepMode) {}

export class PaddingUnits extends enum_prop("PaddingUnits", enums.PaddingUnits) {}

export class StartEnd extends enum_prop("StartEnd", enums.StartEnd) {}

//
// Units Properties
//
export function units_prop<Units>(name: string, valid_units: Units[], default_units: any) {
  return class extends Number {
    init(): void {
      if (this.units == null)
        this.units = default_units

      const units = this.units
      if (!includes(valid_units, units))
        throw new Error(`${name} units must be one of ${valid_units}, given invalid value: ${units}`)
    }

    get units(): Units {
      return this._spec.units as Units
    }

    set units(units: Units) {
      this._spec.units = units
    }
  }
}

//
// DataSpec properties
//

export class AngleSpec extends units_prop("AngleSpec", enums.AngleUnits, "rad") {
  transform(values: Arrayable): Arrayable {
    if (this.units == "deg")
      values = map(values, (x: number) => x * Math.PI/180.0)
    values = map(values, (x: number) => -x)
    return super.transform(values)
  }
}AngleSpec.prototype.dataspec = true

export class ColorSpec extends Color {}
ColorSpec.prototype.dataspec = true

export class DistanceSpec extends units_prop("DistanceSpec", enums.SpatialUnits, "data") {}
DistanceSpec.prototype.dataspec = true

export class FontSizeSpec extends String {}
FontSizeSpec.prototype.dataspec = true

export class MarkerSpec extends String {}
MarkerSpec.prototype.dataspec = true

export class NumberSpec extends Number {}
NumberSpec.prototype.dataspec = true

export class StringSpec extends String {}
StringSpec.prototype.dataspec = true
