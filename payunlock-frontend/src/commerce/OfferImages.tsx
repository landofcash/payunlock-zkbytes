import {useContext, useEffect, useRef, useState} from "react";
import {ArrowLeft, ArrowRight, ImageOff, ImagePlus, Star, Trash2, X, ZoomIn, ZoomOut} from "lucide-react";
import {Button} from "@/components/ui/button";
import {MediaOriginContext, type OfferImage, type Product, useCommerce} from "./client";

const MAX_BYTES = 15 * 1024 * 1024;

export function validateOfferImages(files: File[], count: number) {
  if (count + files.length > 8) throw new Error("Choose up to 8 images per offer.");
  for (const file of files) {
    if (!file.size || file.size > MAX_BYTES) throw new Error("Each image must be between 1 byte and 15 MB.");
    if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.type)) throw new Error("Choose JPEG, PNG, WebP, or AVIF images.");
  }
}

function MediaImage({image, title, thumbnail = false}: { image: OfferImage; title: string; thumbnail?: boolean }) {
  const origin = useContext(MediaOriginContext), [failed, setFailed] = useState(false);
  const src = `${origin}${thumbnail ? image.thumbnailUrl : image.url}`;
  useEffect(() => setFailed(false), [src]);
  return failed ? <span className="offer-image-missing"><ImageOff aria-hidden="true"/>Image unavailable</span> :
    <img src={src} alt={title} loading={thumbnail ? "lazy" : "eager"} width={image.width} height={image.height}
         onError={() => setFailed(true)}/>;
}

export function OfferCover({images, title}: { images: OfferImage[]; title: string }) {
  return <div className="offer-cover">{images[0] ? <MediaImage image={images[0]} title={title} thumbnail/> :
    <span className="offer-image-missing"><ImagePlus aria-hidden="true"/>Digital offer</span>}</div>;
}

export function useOfferDetails(ids: (string | undefined)[]) {
  const api = useCommerce(), [details, setDetails] = useState<Record<string, Product | null>>({});
  const key = [...new Set(ids.filter((id): id is string => !!id))].sort().join(",");
  useEffect(() => {
    let current = true;
    const offerIds = key ? key.split(",") : [];
    void Promise.all(offerIds.map(async id => {
      try {
        return [id, await api.read<Product>(`/products/${id}`)] as const;
      } catch {
        return [id, null] as const;
      }
    })).then(entries => {
      if (current) setDetails(Object.fromEntries(entries));
    });
    return () => {
      current = false;
    };
  }, [key]);
  return details;
}

export function OfferImageEditor({images, onChange, onBusy, stagedFiles, onStagedFilesChange}: {
  images: OfferImage[];
  onChange(images: OfferImage[]): void;
  onBusy(busy: boolean): void;
  stagedFiles?: File[];
  onStagedFilesChange?: (files: File[]) => void
}) {
  const api = useCommerce(), input = useRef<HTMLInputElement>(null), active = useRef(true), running = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [dragging, setDragging] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);
  const latest = useRef({images, onChange, onBusy});
  latest.current = {images, onChange, onBusy};
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const urls = (stagedFiles ?? []).map(file => {
      try {
        return URL.createObjectURL(file);
      } catch {
        return "";
      }
    });
    setPreviews(urls);
    return () => urls.forEach(url => {
      if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    });
  }, [stagedFiles]);

  async function upload(files: File[]) {
    if (running.current || !files.length) return;
    setError("");
    try {
      validateOfferImages(files, images.length + (stagedFiles?.length ?? 0));
      if (onStagedFilesChange) {
        onStagedFilesChange([...(stagedFiles ?? []), ...files]);
        return;
      }
      running.current = true;
      setBusy(true);
      onBusy(true);
      for (const file of files) {
        const image = await api.request<OfferImage>("/seller/images", file);
        if (!active.current) return;
        const next = [...latest.current.images, image];
        latest.current.images = next;
        latest.current.onChange(next);
      }
    } catch (cause) {
      if (active.current) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (active.current) {
        setBusy(false);
        latest.current.onBusy(false);
      }
    }
  }

  function move(from: number, to: number) {
    const next = [...images];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onChange(next);
  }

  function moveStaged(from: number, to: number) {
    const next = [...stagedFiles!];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onStagedFilesChange!(next);
  }

  return <section className="offer-form-section"><h2>Images</h2><p className="offer-help">The first image is your cover.
    Add up to 8 images, 15 MB each. Images are
    public.{onStagedFilesChange ? " Selected images upload when you review the draft." : ""}</p>
    <div className={`offer-image-drop ${dragging ? "is-dragging" : ""}`} onDragOver={e => {
      e.preventDefault();
      setDragging(true);
    }} onDragLeave={() => setDragging(false)} onDrop={e => {
      e.preventDefault();
      setDragging(false);
      void upload(Array.from(e.dataTransfer.files));
    }}>
      <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,image/avif" hidden
             onChange={e => {
               void upload(Array.from(e.target.files ?? []));
               e.target.value = "";
             }}/>
      <Button icon={ImagePlus} variant="secondary" disabled={busy || images.length + (stagedFiles?.length ?? 0) >= 8}
              onClick={() => input.current?.click()}>{busy ? "Uploading images..." : "Add images"}</Button><span>or drop images here · JPEG, PNG, WebP, AVIF</span>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="offer-image-editor">{images.map((image, index) => <div className="offer-image-tile" key={image.id}>
      <MediaImage image={image} title={`Offer image ${index + 1}`} thumbnail/><span
      className="offer-image-label">{index === 0 ? "Main image" : `Image ${index + 1}`}</span>
      <div className="actions">
        <Button icon={Star} size="icon" variant="ghost" aria-label={`Make image ${index + 1} main`}
                disabled={busy || index === 0} onClick={() => move(index, 0)}/>
        <Button icon={ArrowLeft} size="icon" variant="ghost" aria-label={`Move image ${index + 1} earlier`}
                disabled={busy || index === 0} onClick={() => move(index, index - 1)}/>
        <Button icon={ArrowRight} size="icon" variant="ghost" aria-label={`Move image ${index + 1} later`}
                disabled={busy || index === images.length - 1} onClick={() => move(index, index + 1)}/>
        <Button icon={Trash2} size="icon" variant="ghost" aria-label={`Remove image ${index + 1}`} disabled={busy}
                onClick={() => onChange(images.filter(i => i.id !== image.id))}/>
      </div>
    </div>)}{stagedFiles?.map((file, index) => <div className="offer-image-tile"
                                                    key={`${file.name}:${file.lastModified}:${index}`}>
      {previews[index] ? <img src={previews[index]} alt={`Offer image ${images.length + index + 1}`}/> :
        <span className="offer-image-missing">{file.name}</span>}
      <span
        className="offer-image-label">{index === 0 && images.length === 0 ? "Main image" : `Image ${images.length + index + 1}`} · Ready to upload</span>
      <div className="actions">
        <Button icon={Star} size="icon" variant="ghost" aria-label={`Make image ${images.length + index + 1} main`}
                disabled={index === 0} onClick={() => moveStaged(index, 0)}/>
        <Button icon={ArrowLeft} size="icon" variant="ghost"
                aria-label={`Move image ${images.length + index + 1} earlier`} disabled={index === 0}
                onClick={() => moveStaged(index, index - 1)}/>
        <Button icon={ArrowRight} size="icon" variant="ghost"
                aria-label={`Move image ${images.length + index + 1} later`} disabled={index === stagedFiles.length - 1}
                onClick={() => moveStaged(index, index + 1)}/>
        <Button icon={Trash2} size="icon" variant="ghost" aria-label={`Remove image ${images.length + index + 1}`}
                onClick={() => onStagedFilesChange!(stagedFiles.filter((_, i) => i !== index))}/>
      </div>
    </div>)}</div>
  </section>;
}

export function OfferGallery({images, title}: { images: OfferImage[]; title: string }) {
  const [selected, setSelected] = useState(0), [open, setOpen] = useState(false), [zoom, setZoom] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), index = Math.min(selected, images.length - 1), image = images[index];
  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    setSelected(0);
    setZoom(false);
  }, [images.map(i => i.id).join(",")]);

  function select(next: number) {
    setSelected((next + images.length) % images.length);
    setZoom(false);
  }

  if (!image) return null;
  if (image.url === "/v1/media/restricted") return <div className="offer-gallery">
    <div className="offer-gallery-main"><MediaImage image={image} title="Restricted offer"/></div>
  </div>;
  return <div className="offer-gallery">
    <button type="button" className="offer-gallery-main" aria-label="Enlarge offer image" onClick={() => setOpen(true)}>
      <MediaImage image={image} title={title}/></button>
    {images.length > 1 &&
        <div className="offer-gallery-thumbs" aria-label="Offer images">{images.map((item, n) => <button type="button"
                                                                                                         key={item.id}
                                                                                                         aria-label={`Show image ${n + 1}`}
                                                                                                         aria-pressed={n === index}
                                                                                                         onClick={() => select(n)}>
          <MediaImage image={item} title={`${title}, image ${n + 1}`} thumbnail/></button>)}</div>}
    <dialog ref={dialog} className="offer-lightbox" aria-label={`${title} images`} onCancel={() => {
      setOpen(false);
      setZoom(false);
    }} onKeyDown={e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        select(index + (e.key === "ArrowLeft" ? -1 : 1));
      }
    }}>
      <div className="offer-lightbox-toolbar"><span>{index + 1} / {images.length}</span><Button
        icon={zoom ? ZoomOut : ZoomIn} variant="secondary"
        onClick={() => setZoom(!zoom)}>{zoom ? "Zoom out" : "Zoom in"}</Button><Button icon={X} variant="secondary"
                                                                                       onClick={() => {
                                                                                         setOpen(false);
                                                                                         setZoom(false);
                                                                                       }}>Close</Button></div>
      <div className={`offer-lightbox-image ${zoom ? "is-zoomed" : ""}`}><MediaImage image={image} title={title}/></div>
      {images.length > 1 && <div className="offer-lightbox-navigation"><Button icon={ArrowLeft} variant="secondary"
                                                                               onClick={() => select(index - 1)}>Previous</Button><Button
          icon={ArrowRight} variant="secondary" onClick={() => select(index + 1)}>Next</Button></div>}
    </dialog>
  </div>;
}
