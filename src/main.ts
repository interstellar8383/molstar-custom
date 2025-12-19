import { DefaultPluginSpec, PluginSpec } from 'molstar/lib/mol-plugin/spec';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { PluginConfig } from 'molstar/lib/mol-plugin/config';
import { Color } from 'molstar/lib/mol-util/color';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { atoms } from 'molstar/lib/mol-model/structure/query/queries/generators';
import { StructureProperties } from 'molstar/lib/mol-model/structure';
import { QueryContext } from 'molstar/lib/mol-model/structure/query/context';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { MolScriptBuilder as MS, MolScriptBuilder } from 'molstar/lib/mol-script/language/builder';


/** 
 * Highlights input residue positions with spheres of specified color.
 * @param plugin - The Mol* plugin context.
 * @param positions - Array of residue positions (numbers) to highlight.
 * @param colorHex - Hex color string for the spheres (default: red).
 */

export async function highlightResidueWithSphere(
  plugin: PluginContext,
  positions: number[],
  colorHex: string = '#ff0000',
) {



    // Flattens nested arrays
    const flatten = (arr: any): any[] => {
      if (!Array.isArray(arr)) return [arr];
      return arr.reduce((acc: any[], v: any) => {
        if (Array.isArray(v)) return acc.concat(flatten(v));
        return acc.concat(v);
      }, []);
    };

    const rawFlat = flatten(positions);
    const posNums = rawFlat
      .map((p: any) => {
        const n = Number(p);
        return Number.isFinite(n) ? Math.floor(n) : null;
      })
      .filter((n: number | null): n is number => n !== null);

    // remove duplicates 
    const uniquePos = Array.from(new Set(posNums)).sort((a, b) => a - b);

    console.log('cleaned integer positions:', uniquePos);
    if (uniquePos.length === 0) {
      console.warn('No valid positions after cleaning; aborting highlight.');
      return;
    }

    // Checks if colorHex is valid 
    const hex = colorHex.startsWith("#") ? colorHex.slice(1) : colorHex;
    const colorValue = parseInt(hex, 16);
    if (isNaN(colorValue)) {
        console.warn("Invalid color:", colorHex);
        return;
    }

  const structCell = plugin.managers.structure.hierarchy.current.structures[0];

// Selects the structure and prepares to build highlight
const b = plugin.build()
  .to(structCell.cell);

const group = b.apply(
    StateTransforms.Misc.CreateGroup,
    { label: 'mutations' },
    { ref: 'mutations' }
  );


// Molstar query expression to select specified residues' CA atoms in chain A
const expression = MS.struct.generator.atomGroups({
    'chain-test': MS.core.rel.eq(
      [ MS.struct.atomProperty.macromolecular.label_asym_id(), 'A' ]
    ),
    'residue-test': MS.core.set.has([
      MS.set(...uniquePos),
      MS.struct.atomProperty.macromolecular.label_seq_id()
    ]),
    'atom-test': MS.core.rel.eq(
      [ MS.struct.atomProperty.macromolecular.label_atom_id(), 'CA' ]
    )
  });

  // apply representation to the selected residues
    group
    .apply(
      StateTransforms.Model.StructureSelectionFromExpression,
      { expression }
    )
    .apply(
      StateTransforms.Representation.StructureRepresentation3D,
      createStructureRepresentationParams(
        plugin,
        structCell.cell.obj.data,  // data object
        {
          type: 'ball-and-stick',
          color: 'uniform',
          colorParams: { value: Color(colorValue) },
          size: 'uniform',
          sizeParams: { value: 10 }
        }
      ),
      { tags: ['mutations-group'] }
    );

  //commit all the changes
  await b.commit();
}


// Defining Shiny as a global object to allow communication from R Shiny
declare global {
  interface Window {
    Shiny?: {
      addCustomMessageHandler: (type: string, handler: (message: any) => void) => void;
      setInputValue: (name: string, value: any, opts?: { priority?: 'event' | 'default' }) => void;

    };
  }
}

// Cache for tracking overpaint layers (i.e. highlight residues, domains, etc.)
interface OverpaintLayer {
  bundle: StructureElement.Bundle;
  color: Color;
  clear: boolean;
}
const overpaintLayers: OverpaintLayer[] = [];   // <‑‑ cache


const MySpec: PluginSpec = {
  ...DefaultPluginSpec(),
  config: [
    [PluginConfig.VolumeStreaming.Enabled, false]
  ]
};

const cartoonRef = 'cartoon-representation';
let plugin: PluginContext;


// Register message handlers for communication between JS and R Shiny
window.Shiny?.addCustomMessageHandler('initMolstar', (uniprot_id:string) => {
    initMolstar(uniprot_id);
})


window.Shiny?.addCustomMessageHandler(
  "highlightDomains",
  (msg: { residueStart: number; residueEnd: number; colorHex?: string }) => {
    if (!plugin) return console.warn('Mol* not ready');
    highlightDomains(
      plugin,
      msg.residueStart,
      msg.residueEnd,
      msg.colorHex ?? '#ff0000'
    );
  }
);


window.Shiny?.addCustomMessageHandler(
    "highlightResidueWithSphere", 
    (msg: { positions: number; colorHex?: string }) => {
        if (!plugin) return console.warn("Mol* not reaady");
        highlightResidueWithSphere(
            plugin,
            [msg.positions],
            msg.colorHex ?? '#ff0000'
        );
    }
);


window.Shiny?.addCustomMessageHandler(
  "zoomToResidue",
  (msg: {residueNumber: number; chainId?: string}) => {
    if (!plugin) return console.warn("Mol* not ready");
    zoomToResidue(
      plugin,
      msg.residueNumber,
      msg.chainId ?? 'A' 
       );
  }
);


window.Shiny?.addCustomMessageHandler(
  "clearOverlays",
  (_msg: any) => {
    if (!plugin) {
      console.warn("Mol* plugin not ready cannot clear overlays");
      return;
    }
    clearOverlays(plugin);
  }
);


window.Shiny?.addCustomMessageHandler(
  "resetCamera",
  (_msg: any) => {
    if (!plugin) {
      console.warn("Mol* plugin not ready cannot reset camera");
      return;
    }
    resetCamera(plugin);
  }
);


window.Shiny?.addCustomMessageHandler(
  "clearPaint",
  (_msg: any) => {
    if (!plugin) {
      console.warn("Mol* plugin not ready cannot clear overlays");
      return;
    }
    clearPaint(plugin);
  }
)


// Initializes the Mol* plugin and loads proteins based on UniProt ID 
async function initMolstar(uniprot_id:string) {
    // Run once to initialize the viewer
    if (!plugin) {
    plugin = new PluginContext(MySpec);
    await plugin.init();

    const canvas = document.getElementById('molstar-canvas') as HTMLCanvasElement;
    const parent = document.getElementById('molstar-parent') as HTMLDivElement;

    const ok = await plugin.initViewer(canvas, parent);
    if (!ok) {
      console.error('Mol* viewer failed to initialize.');
      return;
    }  

    // Subscribe to hover events to send residue info back to Shiny
      plugin.behaviors.interaction.hover.subscribe(e => {
        const loci = e.current.loci;
        if (!StructureElement.Loci.is(loci) || loci.elements.length === 0) return;

        const info = getResidueInfo(loci);
        if (!info) return;

        const ns = (window as any).MY_MODULE_NS as string; // your module prefix
        // namespaced inputs: 'resi_aa' and 'resi_num'
        window.Shiny!.setInputValue(ns + 'resi_aa', info.aa, { priority: 'event' });
        window.Shiny!.setInputValue(ns + 'resi_num', info.num, { priority: 'event' });
        // (optionally keep the combined string too)
        window.Shiny!.setInputValue(ns + 'resiinfo', info.label, { priority: 'event' });
      });


    // expose for debugging
    (window as any).plugin = plugin;
  }

  // Clears the viewer and cache for new structures
  await plugin.clear();
  overpaintLayers.length = 0

  const data = await plugin.builders.data.download({
    url: 'https://alphafold.ebi.ac.uk/files/AF-'+uniprot_id+'-F1-model_v6.pdb'
  }, { state: { isGhost: true } });
  const trajectory = await plugin.builders.structure.parseTrajectory(data, 'pdb');
  const structure = await plugin.builders.structure.createModel(trajectory);

  // Create structure (model or assembly)
  const structureData = await plugin.builders.structure.createStructure(structure, { name: 'model', params: {} });

  // Create polymer component (e.g. protein chains)
  const polymer = await plugin.builders.structure.tryCreateComponentStatic(structureData, 'polymer');

  if (!polymer) {
    console.warn('No polymer component found');
    return;

  }

  // Add cartoon representation with uniform grey color 
await plugin.build()
  .to(polymer)
  .apply(StateTransforms.Representation.StructureRepresentation3D, {
    type: { name: 'cartoon', params: {} },
    colorTheme: { name: 'uniform', params: { value: Color(0xbebebe) } }
  }, { ref: cartoonRef })
  .commit();

  plugin.managers.camera.reset();
    console.log('initMolstar completed for', uniprot_id);

  console.log('Checking window.Shiny:');

  console.log('Checking window.Shiny:', window.Shiny);

  // Optional: expose plugin for debugging
  (window as any).plugin = plugin;
}


// Clears all overpaint layers and mutations from the structure
async function clearOverlays(plugin: PluginContext) {
  // gets rid of cache
  overpaintLayers.length = 0;

  // transforms the protein to become blank
  await plugin.build()
    .to(cartoonRef)
    .apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle, {
      layers: [],    // no layers = remove all overpaints
    })
    .commit();

  plugin.build().delete('mutations').commit();
  

  console.log('Overpaint layers cleared');
}

// Clears only the overpaint layers from the structure
async function clearPaint(plugin: PluginContext) {
  overpaintLayers.length = 0;

  // transforms the protein to become blank
  await plugin.build()
    .to(cartoonRef)
    .apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle, {
      layers: [],    // no layers = remove all overpaints
    })
    .commit();
  
}

async function clearSpheres(plugin:PluginContext) {
  plugin.build().delete('mutations').commit();
}



// Highlights specified residue range with given color
async function highlightDomains(
    plugin: PluginContext,
    residueStart: number,
    residueEnd: number,
    colorHex: string = "#ff0000"
) {

    const structure = plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data;
    if (!structure) {
        console.warn('No Structure loaded');
        return;
    }

    const hex = colorHex.startsWith("#") ? colorHex.slice(1) : colorHex;
    const colorValue = parseInt(hex, 16);
    if (isNaN(colorValue)) {
        console.warn("Invalid color:", colorHex);
        return;
    }

    const query = atoms({
        residueTest: ctx => {
            const seqId = StructureProperties.residue.label_seq_id(ctx.element);
            return seqId >= residueStart && seqId <= residueEnd;
        }, 
    });

    const selection = query(new QueryContext(structure));
    const bundle = StructureElement.Bundle.fromSelection(selection);

    // Pushes the selection to the cache 
    overpaintLayers.push({
        bundle,
        color: Color(colorValue),
        clear: false          // do not wipe previous paint
    });

    await plugin.build()
    .to(cartoonRef)
    .apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle, 
        {layers: overpaintLayers})
    .commit();

}

// Extracts residue information from hovered loci
function getResidueInfo(loci: any): { aa: string, num: number, label: string } | undefined {
  if (!StructureElement.Loci.is(loci) || !loci.elements || loci.elements.length === 0) return;

  const e = loci.elements[0];
  if (!e.unit) return;
  const unit = e.unit;
  const localIndex = OrderedSet.start(e.indices);
  if (localIndex == null) return;
  const atomIndex = unit.elements[localIndex];
  if (atomIndex == null) return;

  const model = unit.model;
  const residueIndex = model.atomicHierarchy.residueAtomSegments.index[atomIndex];

  const compId = model.atomicHierarchy.atoms.label_comp_id.value[atomIndex] ??
                 model.atomicHierarchy.atoms.label_comp_id.value(atomIndex);
  const seqId = model.atomicHierarchy.residues.label_seq_id.value(residueIndex);

  return { aa: String(compId), num: Number(seqId), label: `${compId} ${seqId}` };
}


// Zooms camera to focus on specified residue in given chain
export async function zoomToResidue(
  plugin: PluginContext,
  residueNumber: number,
  chainId: string = 'A'
) {
  const structure = plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data;
  if (!structure) {
    console.warn('No structure loaded');
    return;
  }

  // Query for the specific residue using the same pattern as highlightDomains function
  const query = atoms({
    chainTest: ctx => {
      const chain = StructureProperties.chain.label_asym_id(ctx.element);
      return chain === chainId;
    },
    residueTest: ctx => {
      const seqId = StructureProperties.residue.label_seq_id(ctx.element);
      return seqId === residueNumber;
    },
  });

  const selection = query(new QueryContext(structure));
  const bundle = StructureElement.Bundle.fromSelection(selection);
  
  // Convert bundle to loci and focus camera
  const loci = StructureElement.Bundle.toLoci(bundle, structure);
  plugin.managers.camera.focusLoci(loci);
  
  console.log(`Zoomed to residue ${residueNumber} in chain ${chainId}`);
  plugin.managers.interactivity.lociHighlights.highlight({ loci });

}


export async function resetCamera(plugin: PluginContext) {
  // Reset camera to fit the entire structure
  plugin.managers.camera.reset();
  
  console.log('Camera view reset to show entire structure');
}


// Exposes functions globally
(window as any).initMolstar = initMolstar;
(window as any).highlightDomains = highlightDomains;
(window as any).clearOverlays = clearOverlays;
(window as any).highlightResidueWithSphere = highlightResidueWithSphere;
(window as any).zoomToResidue = zoomToResidue;

// Automatically loads default protein onto webpage
window.onload = () => {
  initMolstar('P37898');
};
