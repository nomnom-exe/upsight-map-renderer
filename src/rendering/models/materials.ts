/**
 * @file src/rendering/models/materials.ts
 * @brief Shade the surfaces of city models.
 * @author Norman
 * @description Uses metre-based patterns that fade with distance and highlights the selected feature.
 */

import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";

/** When shader derivatives are unavailable, use simpler surfaces and keep wide overlays visible. */
export function surfaceFragment(body: string, engine?: AbstractEngine) {
  const legacy = engine && "webGLVersion" in engine && engine.webGLVersion === 1;
  const derivatives = !legacy || engine.getCaps().standardDerivatives;
  const extension = legacy && derivatives ? "#extension GL_OES_standard_derivatives : enable\n" : "";
  const width = derivatives
    ? "#define pixelWidth(value) fwidth(value)"
    : "float pixelWidth(float value){return 4.0;}\nvec2 pixelWidth(vec2 value){return vec2(4.0);}";
  return extension + "precision highp float;\n" + width + "\n" + body;
}

/** Surface patterns use metres. Window detail fades as it gets smaller than a pixel. */
export const CITY_VERTEX = `precision highp float;
attribute vec3 position; attribute vec3 tint; attribute float featureKey; attribute vec3 surface;
uniform mat4 mapMatrix; uniform float selectedKey;
varying vec3 color; varying vec3 uvMaterial; varying float selected;
void main(){
 gl_Position=mapMatrix*vec4(position,1.0);
 // Give road paint a small depth offset in clip space. This keeps markings
 // just centimetres above the road from flickering at a distance.
 bool roadPaint=(surface.z>4.5 && surface.z<5.5)||(surface.z>10.5 && surface.z<11.5)||(surface.z>12.5 && surface.z<13.5);
 if(roadPaint)gl_Position.z-=0.000001*gl_Position.w;
 color=tint;uvMaterial=surface;selected=abs(featureKey-selectedKey)<0.25?1.0:0.0;
}`;
const citySurface = `
varying vec3 color; varying vec3 uvMaterial; varying float selected;
float noise(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float band(float p,float low,float high,float aa){
 return smoothstep(low-aa,low+aa,p)*(1.0-smoothstep(high-aa,high+aa,p));
}
float windowMask(vec2 f,vec2 aa,vec2 low,vec2 high){
 return band(f.x,low.x,high.x,aa.x)*band(f.y,low.y,high.y,aa.y);
}
float detailFade(vec2 aa){return 1.0-smoothstep(.18,.55,max(aa.x,aa.y));}
void main(){
 vec3 c=color; vec2 uv=uvMaterial.xy; float m=uvMaterial.z;
 // The whole number picks the surface type. The first decimal digit picks one
 // of three patterns, all drawn in the same shader without a texture lookup.
 // Round the packed code before separating its digits. Interpolation can put
 // an integer material just below its value, where fract would wrap to one.
 float variant=mod(floor(m*10.0+.5),10.0);
 if(m>.5 && m<1.5){
   vec2 cell=uv/vec2(1.6+variant*.3,3.2), f=fract(cell);
   vec2 aa=max(pixelWidth(cell),vec2(.004));
   // A vertical window frame can get narrower than a pixel while floor bands
   // are still visible. Fade each direction separately.
   vec2 detail=1.0-smoothstep(vec2(.18),vec2(.55),aa);
   float vertical=(1.0-band(f.x,.045,.955,aa.x))*detail.x;
   float horizontal=(1.0-band(f.y,.11,.89,aa.y))*detail.y;
   float frame=max(vertical,horizontal);
   float sky=.35+.35*smoothstep(0.0,100.0,uv.y);
   c=mix(color*.56,color*.86+vec3(.05,.09,.11),sky);
   if(variant>.5 && variant<1.5)frame=max(frame,band(f.y,.02,.25,aa.y)*detail.y);
   if(variant>1.5)frame=max(frame,band(fract(cell.x/3.0),.91,.99,aa.x/3.0)*(1.0-smoothstep(.18,.55,aa.x/3.0)));
   c=mix(c,color*.98,frame*.85);
 } else if((m>1.5 && m<3.5)||(m>11.5 && m<12.5)){
   bool house=m>11.5;
   vec2 cell=uv/vec2((house?3.8:3.1)+variant*.45,3.2), f=fract(cell);
   vec2 aa=max(pixelWidth(cell),vec2(.005)); float detail=detailFade(aa);
   float window=windowMask(f,aa,vec2(house?.27:.19,.29),vec2(house?.73:.81,.79));
   float mullion=band(f.x,.48,.52,aa.x);
   window*=1.0-mullion*.7;
   vec3 glass=mix(color*.48,vec3(.29,.40,.43),.55);
   c=mix(color,glass,(window*detail+.22*(1.0-detail))*.85);
   if(m>2.5 && m<3.5){
     vec2 brick=uv/vec2(.65,.25);brick.x+=mod(floor(brick.y),2.0)*.5;
     vec2 b=fract(brick), ba=max(pixelWidth(brick),vec2(.01));
     float mortar=1.0-windowMask(b,ba,vec2(.035,.08),vec2(.965,.92));
     c=mix(c,color*.8,mortar*detailFade(ba)*.16*(1.0-window));
   }
   c*=.94+.06*smoothstep(0.0,3.2,uv.y);
 } else if(m>12.5 && m<13.5){
   // Draw a solid line when a 3.5-metre dash is smaller than a pixel.
   if(pixelWidth(uv.y)<3.5 && mod(uv.y,7.0)>3.5)discard;
 } else if((m>4.5 && m<5.5)||(m>10.5 && m<11.5)){
   // Hide road markings when they get too narrow to see.
   // Otherwise they flicker as the map moves.
   if(pixelWidth(uv.x)>.2)discard;
   if(m<5.5 && mod(uv.y,7.0)>3.5)discard;
 }
 else if(m>5.5 && m<6.5){float ripple=sin(uv.x*.12+sin(uv.y*.03));c*=.98+.018*ripple;}
 else if(m>7.5 && m<8.5){
   vec2 cell=uv/vec2(5.0,3.2), f=fract(cell), aa=max(pixelWidth(cell),vec2(.008));
   float opening=windowMask(f,aa,vec2(.06,.25),vec2(.94,.82));
   float detail=detailFade(aa);
   c=mix(color,color*.42,(opening*detail+.45*(1.0-detail))*.9);
 } else if(m>8.5 && m<9.5){
   vec2 cell=uv/vec2(2.9+variant*.55,3.2), f=fract(cell), aa=max(pixelWidth(cell),vec2(.005));
   float detail=detailFade(aa);
   float window=windowMask(f,aa,vec2(.22,.30),vec2(.78,.79));
   float accent=0.0;
   if(variant<.5){
     // Draw vertical service bays and pairs of windows on residential blocks.
     accent=band(fract(cell.x/4.0),.75,.995,aa.x/4.0);
     window*=1.0-band(f.x,.47,.53,aa.x)*.8;
   } else if(variant<1.5){
     // Shade horizontal gallery bands directly onto the wall.
     accent=band(f.y,.04,.21,aa.y);
     window=windowMask(f,aa,vec2(.15,.32),vec2(.85,.80));
   } else {
     accent=1.0-band(f.x,.07,.93,aa.x);
     window*=1.0-band(f.x,.48,.52,aa.x)*.65;
   }
   c=mix(color,color*.77,accent*detail*.65);
   vec3 glass=mix(color*.46,vec3(.28,.39,.41),.55);
   c=mix(c,glass,(window*detail+.27*(1.0-detail))*.88);
   float sill=band(f.y,.23,.28,aa.y);
   c=mix(c,color*1.03,sill*detail*.55);
 } else if(m>9.5 && m<10.5){
   float pitch=.35+variant*.15, aa=pixelWidth(uv.x/pitch);
   float detail=1.0-smoothstep(.2,.6,aa);
   c*=1.0-.06*(.5+.5*cos(uv.x/pitch*6.283185))*detail;
   c*=.92+.08*smoothstep(0.0,2.0,uv.y);
 } else if(m>6.5 && m<7.5){c*=.96+.04*noise(floor(uv*.5));}
 else if(m>3.5 && m<4.5){c*=.98;}
 c=mix(c,vec3(1.0,.72,.25),selected*.48);
 gl_FragColor=vec4(c,1.0);
}`;

export const cityFragment = (engine?: AbstractEngine) => surfaceFragment(citySurface, engine);
export const CITY_FRAGMENT = cityFragment();
