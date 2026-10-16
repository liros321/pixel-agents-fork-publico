import { Button } from './ui/Button.js';

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  return (
    <div
      className="absolute inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onDismiss}
    >
      <div
        className="pixel-panel py-24 px-32 max-w-xl text-center leading-[1.3]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-5xl mb-12 text-accent">Te devemos um pedido de desculpas!</div>
        <p className="text-xl m-0 mb-12">
          Acabamos de migrar para assets 100% open source, todos feitos do zero com carinho.
          Infelizmente, isso significa que seu layout anterior precisou ser resetado.
        </p>
        <p className="text-xl m-0 mb-12">Sentimos muito por isso.</p>
        <p className="text-xl m-0 mb-12">
          A boa notícia? Isso foi coisa de uma vez só, e abre caminho para novidades bem empolgantes
          por vir.
        </p>
        <p className="text-xl m-0 mb-20">Fique de olho, e obrigado por usar o Adaptus Agentes!</p>
        <Button variant="accent" size="xl" onClick={onDismiss}>
          Entendi
        </Button>
      </div>
    </div>
  );
}
