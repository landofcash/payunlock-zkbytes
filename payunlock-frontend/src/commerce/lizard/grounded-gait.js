/* Plays pre-drawn SVG leg poses by distance. Planted paws are anchored in page space. */

  const numberPattern=/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  const clamp=x=>Math.max(0,Math.min(1,x));
  const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
  const rotate=(p,angle)=>{const a=angle*Math.PI/180;return{x:p.x*Math.cos(a)-p.y*Math.sin(a),y:p.x*Math.sin(a)+p.y*Math.cos(a)};};
  export function createLizardGroundedGait(svg){
    const stride=Number(svg.getAttribute('data-stride-length')||140);
    const duty=Number(svg.getAttribute('data-stance-ratio')||.56);
    function bind(animation){
      const strings=animation.getAttribute('values').split(';');
      const values=strings.map(s=>(s.match(numberPattern)||[]).map(Number));
      const template=strings[0].replace(numberPattern,'~');
      const times=animation.getAttribute('keyTimes')?.split(';').map(Number)||values.map((_,i)=>i/(values.length-1));
      const b={el:animation.parentElement,attr:animation.getAttribute('attributeName'),type:animation.getAttribute('type'),template,values,times};
      animation.remove();return b;
    }
    const legs=Array.from(svg.querySelectorAll('.pico-running-art .pico-leg')).map(el=>{
      const bindings=Array.from(el.querySelectorAll('animate,animateTransform')).map(bind);
      const hip=el.getAttribute('data-hip').split(' ').map(Number);
      const paw=el.querySelector('[id$="-paw"]');
      return {id:el.id,hip:{x:hip[0],y:hip[1]},offset:Number(el.getAttribute('data-phase-offset')),baseAngle:Number(el.getAttribute('data-paw-angle')),baseScale:Number(el.getAttribute('data-paw-scale')),bindings,
        move:bindings.find(b=>b.el===paw),turn:bindings.find(b=>b.type==='rotate'),scale:bindings.find(b=>b.type==='scale'),anchor:null,grounded:false};
    });
    function value(b,p){
      let i=0;while(i<b.times.length-2&&b.times[i+1]<=p)i++;
      const u=clamp((p-b.times[i])/(b.times[i+1]-b.times[i]));
      return b.values[i].map((v,j)=>v+(b.values[i+1][j]-v)*u);
    }
    function apply(b,nums){let i=0;let s=b.template.replace(/~/g,()=>nums[i++].toFixed(3));if(b.type)s=b.type+'('+s+')';b.el.setAttribute(b.attr,s);}
    function world(local,p,unit){const v=rotate({x:(local.x-176)*unit,y:(local.y-56)*unit},p.angle);return{x:p.x+v.x,y:p.y+v.y};}
    function local(worldPoint,p,unit){const v=rotate({x:worldPoint.x-p.x,y:worldPoint.y-p.y},-p.angle);return{x:176+v.x/unit,y:56+v.y/unit};}
    let previousDistance=null,contacts=[];
    function reset(){previousDistance=null;legs.forEach(l=>{l.anchor=null;l.grounded=false;});}
    function draw(p,unit){
      if(previousDistance!==null&&p.distance<previousDistance-.01)reset();
      previousDistance=p.distance;
      const phase=((p.distance/stride)%1+1)%1;contacts=[];
      for(const leg of legs){
        const frames=new Map(leg.bindings.map(b=>[b,value(b,phase)]));
        const foot=frames.get(leg.move);const nominal={x:foot[0],y:foot[1]};
        const legPhase=(phase+leg.offset)%1;
        const planted=!p.running||legPhase<duty;
        let dx=0,dy=0;
        if(planted){
          if(!leg.grounded||!leg.anchor){leg.anchor=world(nominal,p,unit);leg.anchorAngle=p.angle+frames.get(leg.turn)[0];}
          const fixed=local(leg.anchor,p,unit);dx=fixed.x-nominal.x;dy=fixed.y-nominal.y;
          frames.set(leg.move,[fixed.x,fixed.y]);frames.set(leg.turn,[leg.anchorAngle-p.angle]);
          // Supporting toes stay spread and flat, instead of continuing to curl in place.
          frames.set(leg.scale,[leg.baseScale,leg.baseScale]);
        }else{leg.anchor=null;}
        leg.grounded=planted;
        const reach=Math.max(1,Math.hypot(nominal.x-leg.hip.x,nominal.y-leg.hip.y));
        for(const binding of leg.bindings){
          const numbers=frames.get(binding);
          if(binding.attr==='d'&&(dx||dy)){
            // Small path correction follows a planted wrist while the shoulder stays attached.
            for(let i=0;i<numbers.length;i+=2){const weight=smooth((Math.hypot(numbers[i]-leg.hip.x,numbers[i+1]-leg.hip.y)/reach-.10)/.90);numbers[i]+=dx*weight;numbers[i+1]+=dy*weight;}
          }
          apply(binding,numbers);
        }
        const point=frames.get(leg.move),position=world({x:point[0],y:point[1]},p,unit);
        contacts.push({id:leg.id,planted,x:position.x,y:position.y,phase:legPhase,correction:Math.hypot(dx,dy)*unit});
      }
      const torso=svg.querySelector('.pico-running-art .pico-torso');
      if(torso)torso.style.transform=`rotate(${.5*Math.sin(phase*2*Math.PI)}deg)`;
      return contacts;
    }
    svg.classList.add('is-distance-driven');
    return {stride,draw,reset,contacts:()=>contacts.map(p=>({...p}))};
  }


