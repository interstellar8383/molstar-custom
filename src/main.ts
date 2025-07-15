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

    plugin.behaviors.interaction.hover.subscribe(e => {
        const loci = e.current.loci;

        if (loci.kind === 'element-loci') {
            const label = getResidueInfo(loci);
            if (label) {
                window.Shiny!.setInputValue('hoveredResidue', label, { priority: 'event' });
            }
        }
    }); 


    // expose for debugging
    (window as any).plugin = plugin;
  }

  // Clears the viewer and cache for new structures
  await plugin.clear();
  overpaintLayers.length = 0

  const data = await plugin.builders.data.download({
    url: 'https://alphafold.ebi.ac.uk/files/AF-'+uniprot_id+'-F1-model_v4.pdb'
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
  // Highlight residue 200 in red
  await highlightDomains(plugin, 200, 300);

  console.log('Checking window.Shiny:');

  console.log('Checking window.Shiny:', window.Shiny);

  // Optional: expose plugin for debugging
  (window as any).plugin = plugin;
}



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


function getResidueInfo(loci: any): string | undefined {
    // must be a structure‑element loci
    if (!StructureElement.Loci.is(loci) || loci.elements.length === 0) return;

    const e  = loci.elements[0];
    const unit = e.unit;
    const idx = OrderedSet.start(e.indices);        // <-- take 1st atom in the residue

    const model = unit.model;
    const residueIndex = model.atomicHierarchy.residueAtomSegments.index[idx];

    const compId = model.atomicHierarchy.atoms.label_comp_id.value(idx);          // e.g. “GLY”
    const seqId  = model.atomicHierarchy.residues.label_seq_id.value(residueIndex); // e.g. 104

    return `${compId} ${seqId}`;
}

// Exposes functions globally
(window as any).initMolstar = initMolstar;
(window as any).highlightDomains = highlightDomains;

// Automatically loads default protein onto webpage
window.onload = () => {
  initMolstar('P37898');
};
