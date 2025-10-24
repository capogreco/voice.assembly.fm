# Schema-Driven Parameter UI Generation

This module provides a dynamic UI generation system for Voice.Assembly.FM
parameter controls, eliminating repetitive HTML and enabling easy addition of
new parameters.

## Overview

The current implementation supports both static HTML controls (existing) and
dynamic schema-driven generation. This allows for gradual migration and testing.

## Parameter Types

### 1. HRG Parameters (Harmonic Ratio Generator)

**Used for:** frequency, vibratoRate

**Structure:**

- Base value input (number)
- Interpolation selector (step/cosine)
- Start HRG: numerators/denominators with behaviors
- End HRG: numerators/denominators with behaviors (shown for cosine
  interpolation)

### 2. Normalized Parameters (0-1 range)

**Used for:** vowelX, vowelY, zingAmount, zingMorph, symmetry, amplitude,
whiteNoise, vibratoWidth

**Structure:**

- Start value input (text, supports ranges like "0.2-0.8")
- Start RBG behavior selector (hidden until range detected)
- Interpolation selector (step/cosine)
- End value input (text, supports ranges)
- End RBG behavior selector (hidden until range detected)

## Usage

### Option 1: Full Dynamic Generation (Recommended for new deployments)

1. **Enable in HTML:** Uncomment the container in `index.html`:
   ```html
   <div id="generated-parameters"></div>
   ```

2. **Remove static controls:** Delete the existing parameter control HTML blocks

3. **The system will automatically:**
   - Generate all parameter controls from schema
   - Apply proper event handlers
   - Initialize with default values

### Option 2: Gradual Replacement (Safe for existing deployments)

- Leave existing HTML intact
- The system will automatically enhance/replace controls as needed
- No breaking changes to existing functionality

## Adding New Parameters

### 1. Define Schema

Add to `PARAMETER_SCHEMAS` in `generator.js`:

```javascript
newParameter: {
  type: PARAMETER_TYPES.NORMALIZED, // or HRG
  label: 'new param',
  defaultValue: '0.5',
  placeholder: '0.5 or 0.2-0.8'
}
```

### 2. Add to Parameter Order

Include in the `parameterOrder` array for proper sequencing.

### 3. Setup Event Handlers

Add to `setupEnvelopeControls()` in `controls.js`:

```javascript
setupCompactParameterControls(ctrl, "newParameter");
```

## Schema Definition Format

### HRG Parameter Schema

```javascript
{
  type: PARAMETER_TYPES.HRG,
  label: 'display name',
  baseInput: {
    type: 'number',
    value: 'default',
    min: 'minimum',
    max: 'maximum', 
    step: 'increment',
    placeholder: 'hint text'
  }
}
```

### Normalized Parameter Schema

```javascript
{
  type: PARAMETER_TYPES.NORMALIZED,
  label: 'display name',
  defaultValue: 'default value',
  placeholder: 'hint text for ranges'
}
```

## Benefits

1. **DRY Principle:** Eliminates 90% of repetitive parameter HTML
2. **Consistency:** All parameters follow same structure and styling
3. **Maintainability:** Single source of truth for parameter definitions
4. **Extensibility:** Easy to add new parameters or modify existing ones
5. **Type Safety:** Schema validation ensures correct parameter structure

## Generated HTML Structure

The system generates semantically identical HTML to the existing static
controls, ensuring:

- Same CSS classes and styling
- Same DOM element IDs for event binding
- Same accessibility attributes
- Same responsive behavior

## Migration Path

1. **Phase 1:** Test with schema generation disabled (current state)
2. **Phase 2:** Enable gradual replacement mode for testing
3. **Phase 3:** Switch to full dynamic generation
4. **Phase 4:** Remove static HTML for parameters

## Files Structure

```
public/ctrl/ui/
├── generator.js      # Schema definitions and HTML generation
├── schema.js         # Parameter control setup and event binding  
├── controls.js       # Main UI control orchestration
└── README-schema-ui.md # This documentation
```

## Advanced Features

### Custom Parameter Types

Extend `PARAMETER_TYPES` and add generation functions for specialized controls.

### Dynamic Schema Updates

Schemas can be modified at runtime to change parameter behavior or appearance.

### Validation Integration

Schema definitions can include validation rules that are automatically applied.

## Testing

The system is designed to be backwards compatible. Existing functionality
continues to work unchanged while the schema system provides enhancement
opportunities.

To test dynamic generation:

1. Uncomment `<div id="generated-parameters"></div>` in HTML
2. Comment out existing parameter control HTML blocks
3. Refresh page to see dynamically generated controls
4. Verify all functionality works identically
